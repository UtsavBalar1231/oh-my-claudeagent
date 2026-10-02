import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fakeExec } from "../../tests/fixtures/fake-exec.ts";
import { specEnv } from "../../tests/fixtures/spec-env.ts";
import { tools } from "./catalog.ts";

const SERVER = join(import.meta.dir, "..", "omca.ts");
const REPO = join(import.meta.dir, "..", "..");
const HOOKS_INACTIVE = {
  runtime: "hooks_inactive",
  runtime_reason:
    "No OMCA settings hook has reached the server in this session, so hooks are off: `disableAllHooks` is set, or an organization policy sets `allowManagedHooksOnly`.",
};
const MOD_ABSENT = {
  runtime: "mod_absent",
  runtime_reason:
    "The OMCA mod has not marked this session since the last prompt, so it is not running: an organization policy sets `allowManagedModsOnly`, the session started with `--safe-mode`, or the mod worker crashed three times and was unloaded.",
};

type Report = {
  runtime: string;
  runtime_reason?: string;
  client_version: string | null;
  ast_grep: { path: string } | { error: string };
  state: Record<string, string>;
};

const running: Array<Bun.Subprocess<"pipe", "pipe", "pipe">> = [];
const temps: string[] = [];

afterEach(() => {
  for (const proc of running.splice(0)) proc.kill("SIGKILL");
  for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), `omca-${prefix}-`)));
  temps.push(path);
  return path;
}

function gitProject(): string {
  const project = tempDir("project");
  expect(Bun.spawnSync(["git", "init", "-q", project], { env: process.env }).exitCode).toBe(0);
  return project;
}

function startServer(env: Record<string, string | undefined> = {}) {
  const project = gitProject();
  const proc = Bun.spawn([process.execPath, SERVER], {
    cwd: project,
    env: specEnv({ CLAUDE_CONFIG_DIR: tempDir("config"), OMCA_HOOK_TRACE: undefined, AI_AGENT: undefined, AST_GREP_BIN: undefined, ...env }),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  running.push(proc);
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let nextId = 1;
  const call = async (name: string, args: Record<string, string> = {}): Promise<string> => {
    const id = nextId++;
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
    proc.stdin.flush();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        const reply = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        expect(reply.id).toBe(id);
        return reply.result.content[0].text;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("the server closed stdout");
      buffer += decoder.decode(value, { stream: true });
    }
  };
  const report = async (args: Record<string, string> = {}): Promise<Report> => JSON.parse(await call("health_check", args));
  const health = async () => {
    const { client_version, ast_grep, state, ...runtime } = await report();
    return runtime;
  };
  const prompt = (sessionId: string) => call("omca_hook", { event: "UserPromptSubmit", session_id: sessionId, prompt: "go" });
  const mark = (sessionId: string, writtenAt: number) => {
    mkdirSync(join(project, ".omca", "state", "mod"), { recursive: true });
    writeFileSync(join(project, ".omca", "state", "mod", `${sessionId}.json`), JSON.stringify({ written_at: writtenAt }));
  };
  return { health, report, prompt, mark, project };
}

test("health_check reports hooks_inactive before any hook call reaches the server", async () => {
  const { health, mark } = startServer();
  mark("s-1", Date.now());
  expect(await health()).toEqual(HOOKS_INACTIVE);
});

test("health_check reports mod_absent when the session has no mod marker", async () => {
  const { health, prompt } = startServer();
  await prompt("s-1");
  expect(await health()).toEqual(MOD_ABSENT);
});

test("health_check reports mod_absent when the marker predates the last prompt", async () => {
  const { health, prompt, mark } = startServer();
  mark("s-1", Date.now() - 60_000);
  await prompt("s-1");
  expect(await health()).toEqual(MOD_ABSENT);
});

test("health_check reports ok once the mod marks the session after its last prompt", async () => {
  const { health, prompt, mark } = startServer();
  await prompt("s-1");
  await Bun.sleep(5);
  mark("s-1", Date.now());
  expect(await health()).toEqual({ runtime: "ok" });
});

test("health_check judges the session of the latest hook call, not an earlier one", async () => {
  const { health, prompt, mark } = startServer();
  await prompt("s-1");
  await Bun.sleep(5);
  mark("s-1", Date.now());
  await prompt("s-2");
  expect(await health()).toEqual(MOD_ABSENT);
});

test.each([
  ["claude-code_2-1-287_agent", "2.1.287"],
  ["claude-code_2-1-286_harness", "2.1.286"],
  ["claude-code_10-20-300_agent", "10.20.300"],
  ["some-other-agent", null],
  [undefined, null],
])("health_check reads the client version from AI_AGENT=%p as %p", async (agent, version) => {
  const { report } = startServer({ AI_AGENT: agent });
  expect((await report()).client_version).toBe(version);
});

test("health_check names the ast-grep binary the server resolves", async () => {
  const bin = fakeExec(tempDir("bin"), "fake-ast-grep", 'console.log("ast-grep 0.0.0");');
  const { report } = startServer({ AST_GREP_BIN: bin });
  expect((await report()).ast_grep).toEqual({ path: bin });
});

test("health_check reports the install hint when no ast-grep binary is on PATH", async () => {
  const { report } = startServer({ PATH: tempDir("empty-path") });
  const { ast_grep } = await report();
  expect("error" in ast_grep && ast_grep.error.startsWith("ast-grep binary not found (looked for $AST_GREP_BIN, ast-grep and sg on PATH).")).toBe(true);
});

test("health_check reports a fresh project's state directory present and its state files absent", async () => {
  const { report } = startServer();
  expect((await report()).state).toEqual({
    dir: "present",
    "boulder.json": "absent",
    "verification-evidence.json": "absent",
  });
});

test("health_check tells a valid state file from one that does not parse", async () => {
  const { report, project } = startServer();
  mkdirSync(join(project, ".omca", "state"), { recursive: true });
  mkdirSync(join(project, ".omca", "evidence"), { recursive: true });
  writeFileSync(join(project, ".omca", "state", "boulder.json"), '{"plans": {}, "bindings": {}}');
  writeFileSync(join(project, ".omca", "evidence", "verification-evidence.json"), '{"entries": [');
  expect((await report()).state).toEqual({
    dir: "present",
    "boulder.json": "valid",
    "verification-evidence.json": "invalid",
  });
});

test("health_check inspects the project named by working_directory", async () => {
  const { report } = startServer();
  const other = gitProject();
  expect((await report({ working_directory: other })).state).toEqual({
    dir: "absent",
    "boulder.json": "absent",
    "verification-evidence.json": "absent",
  });
});

const tool = (name: string) => {
  const found = tools.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no tool named ${name}`);
  return found;
};

function withPluginRoot<T>(root: string | undefined, run: () => Promise<T>): Promise<T> {
  const saved = process.env.CLAUDE_PLUGIN_ROOT;
  if (root === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
  else process.env.CLAUDE_PLUGIN_ROOT = root;
  return run().finally(() => {
    if (saved === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = saved;
  });
}

const callIn = async (root: string | undefined, name: string, args: Record<string, unknown> = {}) =>
  withPluginRoot(root, async () => tool(name).call(args));

function plugin(files: Record<string, string>): string {
  const root = tempDir("plugin");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const agent = (...lines: string[]) => ["---", ...lines, "---", "Body", ""].join("\n");

test("the three tools are declared read-only, health_check first", () => {
  expect(tools.map(({ name, annotations }) => ({ name, annotations }))).toEqual(
    ["health_check", "agents_list", "categories_list"].map((name) => ({
      name,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    })),
  );
});

test("agents_list returns each agent file's name, description, model and cost tier, sorted by file name", async () => {
  const root = plugin({
    "agents/b-opus.md": agent("name: bee", "description: Does B: carefully", "model: opus"),
    "agents/a-fable.md": agent("name: ay", "description: Does A", "model: fable"),
    "agents/c-haiku.md": agent("name: sea", "model: haiku"),
    "agents/d-default.md": agent("description: No name, no model"),
    "agents/e-unknown.md": agent("name: eee", "model: mystery"),
    "agents/f-full-id.md": agent("name: eff", "model: claude-opus-4-8"),
    "agents/g-quoted.md": agent("name: gee", 'description: "Quoted"', "model: claude-sonnet-5-5"),
    "agents/h-empty-model.md": agent("name: aitch", "model:"),
  });
  const expected = [
    { name: "ay", description: "Does A", default_model: "fable", cost_tier: "premium" },
    { name: "bee", description: "Does B: carefully", default_model: "opus", cost_tier: "expensive" },
    { name: "sea", description: "", default_model: "haiku", cost_tier: "free" },
    { name: "d-default", description: "No name, no model", default_model: "sonnet", cost_tier: "cheap" },
    { name: "eee", description: "", default_model: "mystery", cost_tier: "cheap" },
    { name: "eff", description: "", default_model: "claude-opus-4-8", cost_tier: "expensive" },
    { name: "gee", description: "Quoted", default_model: "claude-sonnet-5-5", cost_tier: "cheap" },
    { name: "aitch", description: "", default_model: "sonnet", cost_tier: "cheap" },
  ];
  expect(await callIn(root, "agents_list")).toBe(JSON.stringify(expected, null, 2));
});

test("agents_list skips files without frontmatter and files that are not Markdown", async () => {
  const root = plugin({
    "agents/real.md": agent("name: real"),
    "agents/plain.md": "# Just text\nname: not-frontmatter\n",
    "agents/unclosed.md": "---\nname: unclosed\n",
    "agents/notes.txt": agent("name: text-file"),
  });
  expect(JSON.parse(await callIn(root, "agents_list"))).toEqual([
    { name: "real", description: "", default_model: "sonnet", cost_tier: "cheap" },
  ]);
});

test("agents_list is an empty array when the plugin has no agents directory", async () => {
  expect(await callIn(plugin({ "servers/categories.json": "{}" }), "agents_list")).toBe("[]");
});

test("agents_list names the file and line of frontmatter it cannot read", async () => {
  const root = plugin({ "agents/bad.md": agent("name: bad", "description: >-", "  folded") });
  await expect(callIn(root, "agents_list")).rejects.toThrow("agents/bad.md: frontmatter line 3: block scalars are not supported: description: >-");
});

test("agents_list over the shipped roster lists every agent file with its model and cost tier", async () => {
  const roster = JSON.parse(await callIn(undefined, "agents_list")) as Array<Record<string, string>>;
  expect(roster.map(({ name, default_model, cost_tier }) => [name, default_model, cost_tier])).toEqual([
    ["executor", "sonnet", "cheap"],
    ["explore", "sonnet", "cheap"],
    ["hephaestus", "opus", "expensive"],
    ["librarian", "sonnet", "cheap"],
    ["metis", "opus", "expensive"],
    ["momus", "opus", "expensive"],
    ["multimodal-looker", "opus", "expensive"],
    ["oracle", "fable", "premium"],
    ["prometheus", "opus", "expensive"],
    ["sisyphus", "opus", "expensive"],
  ]);
  for (const entry of roster) expect(entry.description).not.toBe("");
});

test("categories_list re-serializes categories.json with two-space indentation", async () => {
  const root = plugin({ "servers/categories.json": '{\n\t"categories": {\n\t\t"quick": {"model": "sonnet"}\n\t}\n}\n' });
  expect(await callIn(root, "categories_list")).toBe(
    ['{', '  "categories": {', '    "quick": {', '      "model": "sonnet"', "    }", "  }", "}"].join("\n"),
  );
});

test("categories_list reports a missing and a malformed categories.json as JSON errors", async () => {
  expect(await callIn(plugin({ "agents/a.md": agent("name: a") }), "categories_list")).toBe('{"error": "categories.json not found"}');
  expect(await callIn(plugin({ "servers/categories.json": '{"categories": ' }), "categories_list")).toBe(
    '{"error": "categories.json is malformed"}',
  );
});

test("categories_list over the shipped file maps every category to an Agent-tool model alias", async () => {
  const data = JSON.parse(await callIn(undefined, "categories_list"));
  expect(Object.keys(data)).toEqual(["categories"]);
  const models = Object.values<{ model: string }>(data.categories).map((category) => category.model);
  expect(models.length).toBeGreaterThan(0);
  for (const model of models) expect(["sonnet", "opus", "haiku", "fable"]).toContain(model);
  expect(JSON.parse(readFileSync(join(REPO, "servers", "categories.json"), "utf8"))).toEqual(data);
});
