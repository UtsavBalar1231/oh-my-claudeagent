import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER = join(import.meta.dir, "..", "omca.ts");
const CONFIG_DIR = join(import.meta.dir, "..", "..", "tests", "fixtures", "home", "without-block", ".claude");
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

type Server = { proc: Bun.Subprocess<"pipe", "pipe", "pipe">; project: string };

const running: Server[] = [];

afterEach(() => {
  for (const { proc, project } of running.splice(0)) {
    proc.kill("SIGKILL");
    rmSync(project, { recursive: true, force: true });
  }
});

function startServer() {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "omca-health-")));
  expect(Bun.spawnSync(["git", "init", "-q", project]).exitCode).toBe(0);
  const env: Record<string, string | undefined> = { ...process.env, OMCA_SERVER_ROLE: "hooks", CLAUDE_CONFIG_DIR: CONFIG_DIR };
  delete env.OMCA_HOOK_TRACE;
  const proc = Bun.spawn([process.execPath, SERVER], { cwd: project, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  running.push({ proc, project });
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
  const health = async () => JSON.parse(await call("health_check"));
  const prompt = (sessionId: string) => call("omca_hook", { event: "UserPromptSubmit", session_id: sessionId, prompt: "go" });
  const mark = (sessionId: string, writtenAt: number) => {
    mkdirSync(join(project, ".omca", "state", "mod"), { recursive: true });
    writeFileSync(join(project, ".omca", "state", "mod", `${sessionId}.json`), JSON.stringify({ written_at: writtenAt }));
  };
  return { health, prompt, mark };
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
