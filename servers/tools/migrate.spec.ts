import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { migrate, type MigrateOptions, tools } from "./migrate.ts";

const BACKUP = ".bak-omca-migrate";
const POSIX = process.platform !== "win32";
const EMPTY = { actions: [], collisions: [], mentions: [] };

let base: string;
let root: string;
let home: string;
let config: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "omca-migrate-")));
  root = join(base, "project");
  home = join(base, "home");
  config = join(home, ".claude");
  mkdirSync(root, { recursive: true });
  mkdirSync(config, { recursive: true });
  savedEnv = { XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"], HOME: process.env["HOME"], CLAUDE_CONFIG_DIR: process.env["CLAUDE_CONFIG_DIR"] };
  delete process.env["XDG_CONFIG_HOME"];
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(base, { recursive: true, force: true });
});

const run = (options: Partial<MigrateOptions> = {}) => migrate({ apply: false, mergeIndexes: false, root, configDir: config, home, ...options });
const apply = (options: Partial<MigrateOptions> = {}) => run({ apply: true, ...options });

function put(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function snapshot(dir: string, out: Record<string, string> = {}, prefix = ""): Record<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, entry.name);
    const key = `${prefix}${entry.name}`;
    if (entry.isSymbolicLink()) out[key] = `-> ${readlinkSync(path)}`;
    else if (entry.isDirectory()) {
      out[`${key}/`] = "";
      snapshot(path, out, `${key}/`);
    } else out[key] = readFileSync(path, "utf8");
  }
  return out;
}

const memory = (scope: string, name: string) => join(scope, `oh-my-claudeagent-${name}`);
const projectMemory = (name: string) => memory(join(root, ".claude", "agent-memory"), name);
const read = (path: string) => readFileSync(path, "utf8");

describe("a dry run", () => {
  test("writes nothing and reports what apply would do", () => {
    const old = projectMemory("sisyphus");
    put(join(old, "MEMORY.md"), "- [a](a.md)\n");
    put(join(old, "a.md"), "a");
    put(join(memory(join(config, "agent-memory"), "oracle"), "note.md"), "n");
    put(join(projectMemory("momus"), "MEMORY.md"), "- [m](m.md)\n");
    put(join(projectMemory("reviewer"), "MEMORY.md"), "- [r](r.md)\n");
    put(join(root, ".claude", "settings.json"), '{"agent":"oh-my-claudeagent:sisyphus"}\n');
    put(join(root, "opencode.json"), '{"agent":{"omca-sisyphus":{}}}\n');
    put(join(root, "CLAUDE.md"), "use `sisyphus`\n");
    const before = snapshot(base);

    const report = run({ mergeIndexes: true });

    expect(snapshot(base)).toEqual(before);
    expect(report.actions.map(({ kind, from, to }) => [kind, from, to])).toEqual([
      ["move-dir", old, projectMemory("orchestrator")],
      ["move-aside", join(projectMemory("momus"), "MEMORY.md"), join(projectMemory("reviewer"), "MEMORY.from-momus.md")],
      ["remove-dir", projectMemory("momus"), undefined],
      ["backup", join(projectMemory("reviewer"), "MEMORY.md"), `${join(projectMemory("reviewer"), "MEMORY.md")}${BACKUP}`],
      ["merge-index", join(projectMemory("reviewer"), "MEMORY.from-momus.md"), join(projectMemory("reviewer"), "MEMORY.md")],
      ["remove-file", join(projectMemory("reviewer"), "MEMORY.from-momus.md"), undefined],
      ["move-dir", memory(join(config, "agent-memory"), "oracle"), memory(join(config, "agent-memory"), "architect")],
      ["backup", join(root, ".claude", "settings.json"), `${join(root, ".claude", "settings.json")}${BACKUP}`],
      ["rewrite", join(root, ".claude", "settings.json"), undefined],
      ["backup", join(root, "opencode.json"), `${join(root, "opencode.json")}${BACKUP}`],
      ["rewrite", join(root, "opencode.json"), undefined],
    ]);
    expect(report.mentions).toEqual([{ path: join(root, "CLAUDE.md"), reason: expect.any(String) }]);
  });
});

describe("memory directories", () => {
  test("a directory the target lacks moves whole and the old one is gone", () => {
    const old = projectMemory("explore");
    put(join(old, "MEMORY.md"), "- [a](a.md)\n");
    put(join(old, "nested", "deep.md"), "deep");
    const moved = snapshot(old);

    const report = apply();

    expect(existsSync(old)).toBe(false);
    expect(snapshot(projectMemory("explorer"))).toEqual(moved);
    expect(report.collisions).toEqual([]);
  });

  test("local and user scopes move the same way, and an empty old directory is removed", () => {
    put(join(memory(join(root, ".claude", "agent-memory-local"), "librarian"), "x.md"), "x");
    put(join(memory(join(config, "agent-memory"), "hephaestus"), "y.md"), "y");
    mkdirSync(projectMemory("prometheus"), { recursive: true });

    apply();

    expect(read(join(memory(join(root, ".claude", "agent-memory-local"), "researcher"), "x.md"))).toBe("x");
    expect(read(join(memory(join(config, "agent-memory"), "build-fixer"), "y.md"))).toBe("y");
    expect(existsSync(projectMemory("prometheus"))).toBe(false);
    expect(existsSync(projectMemory("planner"))).toBe(false);
  });

  test("a merge moves what the target lacks, sets a colliding file aside, and removes the emptied directory", () => {
    const old = projectMemory("sisyphus");
    const current = projectMemory("orchestrator");
    put(join(old, "MEMORY.md"), "# Old\n- [b](b.md) bee\n- [a](a.md) ay\n");
    put(join(old, "a.md"), "old a");
    put(join(old, "b.md"), "b");
    put(join(old, "sub", "x.md"), "x old");
    put(join(old, "sub", "y.md"), "y");
    put(join(old, "plain"), "no extension");
    put(join(current, "MEMORY.md"), "# New\n- [a](a.md) ay\n");
    put(join(current, "a.md"), "new a");
    put(join(current, "sub", "x.md"), "x new");
    put(join(current, "plain"), "kept");

    const report = apply();

    expect(existsSync(old)).toBe(false);
    expect(snapshot(current)).toEqual({
      "MEMORY.md": "# New\n- [a](a.md) ay\n",
      "MEMORY.from-sisyphus.md": "# Old\n- [b](b.md) bee\n- [a](a.md) ay\n",
      "a.md": "new a",
      "a.from-sisyphus.md": "old a",
      "b.md": "b",
      plain: "kept",
      "plain.from-sisyphus": "no extension",
      "sub/": "",
      "sub/x.md": "x new",
      "sub/x.from-sisyphus.md": "x old",
      "sub/y.md": "y",
    });
    expect(report.collisions.map(({ from, to }) => [from, to]).sort()).toEqual(
      [
        [join(old, "MEMORY.md"), join(current, "MEMORY.from-sisyphus.md")],
        [join(old, "a.md"), join(current, "a.from-sisyphus.md")],
        [join(old, "plain"), join(current, "plain.from-sisyphus")],
        [join(old, "sub", "x.md"), join(current, "sub", "x.from-sisyphus.md")],
      ].sort(),
    );
  });

  test("an index merge appends the missing pointer lines, backs the target up, and removes the from-file", () => {
    const old = projectMemory("sisyphus");
    const current = projectMemory("orchestrator");
    put(join(old, "MEMORY.md"), "# Old\n- [b](b.md) bee\n- [a](a.md) ay\n");
    put(join(current, "MEMORY.md"), "# New\n- [a](a.md) ay\n");
    apply();
    expect(existsSync(join(current, "MEMORY.from-sisyphus.md"))).toBe(true);

    apply({ mergeIndexes: true });

    expect(read(join(current, "MEMORY.md"))).toBe("# New\n- [a](a.md) ay\n# Old\n- [b](b.md) bee\n");
    expect(read(join(current, `MEMORY.md${BACKUP}`))).toBe("# New\n- [a](a.md) ay\n");
    expect(existsSync(join(current, "MEMORY.from-sisyphus.md"))).toBe(false);
  });

  test("an index merge lands inline bullets too, in order, and uses an epoch backup name when one exists", () => {
    const old = projectMemory("momus");
    const current = projectMemory("reviewer");
    const fromFile = ["# Momus memory", "", "- First inline fact.", "- [p](p.md) pointer", "  - nested inline", "", "- Last inline fact."].join("\n");
    put(join(old, "MEMORY.md"), `${fromFile}\n`);
    put(join(current, "MEMORY.md"), "- [p](p.md) pointer");
    put(join(current, `MEMORY.md${BACKUP}`), "older backup");

    apply({ mergeIndexes: true });

    expect(read(join(current, "MEMORY.md"))).toBe(
      ["- [p](p.md) pointer", "# Momus memory", "- First inline fact.", "  - nested inline", "- Last inline fact."].join("\n") + "\n",
    );
    expect(read(join(current, `MEMORY.md${BACKUP}`))).toBe("older backup");
    const epochBackups = readdirSync(current).filter((name) => name.startsWith(`MEMORY.md${BACKUP}.`));
    expect(epochBackups).toHaveLength(1);
    expect(read(join(current, epochBackups[0] ?? ""))).toBe("- [p](p.md) pointer");
    expect(readdirSync(current).sort()).toEqual(["MEMORY.md", `MEMORY.md${BACKUP}`, ...epochBackups]);
  });

  test("a from-file whose lines are all in the target is removed without a backup or a rewrite", () => {
    const current = projectMemory("orchestrator");
    put(join(current, "MEMORY.md"), "- one\n- two\n");
    put(join(current, "MEMORY.from-sisyphus.md"), "- two\n\n- one\n");

    apply({ mergeIndexes: true });

    expect(snapshot(current)).toEqual({ "MEMORY.md": "- one\n- two\n" });
  });

  test("a symlinked old directory is reported and never followed", () => {
    if (!POSIX) return;
    const outside = join(base, "elsewhere");
    put(join(outside, "f.md"), "f");
    mkdirSync(dirname(projectMemory("sisyphus")), { recursive: true });
    symlinkSync(outside, projectMemory("sisyphus"));
    const before = snapshot(base);

    const report = apply();

    expect(snapshot(base)).toEqual(before);
    expect(report.mentions).toEqual([{ path: projectMemory("sisyphus"), reason: expect.stringContaining("symlinked") }]);
  });

  test("a symlinked entry stays where it is and is listed as a collision", () => {
    if (!POSIX) return;
    const old = projectMemory("sisyphus");
    const outside = put(join(base, "elsewhere", "f.md"), "f");
    put(join(old, "real.md"), "real");
    symlinkSync(outside, join(old, "link.md"));
    put(join(projectMemory("orchestrator"), "other.md"), "other");

    const report = apply();

    expect(read(join(projectMemory("orchestrator"), "real.md"))).toBe("real");
    expect(readlinkSync(join(old, "link.md"))).toBe(outside);
    expect(report.collisions).toEqual([{ from: join(old, "link.md"), to: join(projectMemory("orchestrator"), "link.md"), reason: expect.any(String) }]);
    expect(read(outside)).toBe("f");
  });
});

describe("settings", () => {
  const ORIGINAL = [
    "{",
    '  "agent": "oh-my-claudeagent:sisyphus",',
    '  "permissions": { "allow": ["Agent(oh-my-claudeagent:multimodal-looker)", "Agent(oh-my-claudeagent:sisyphus-junior)"] },',
    '  "other": ["oh-my-claudeagent:momus", "oh-my-claudeagent:explorer", "oh-my-claudeagent:explore"]',
    "}",
    "",
  ].join("\n");
  const REWRITTEN = ORIGINAL.replace(":sisyphus\"", ":orchestrator\"")
    .replace(":multimodal-looker", ":viewer")
    .replace(":momus", ":reviewer")
    .replace(/:explore"\]/, ':explorer"]');

  test("whole-word ids are rewritten in the user, project and local files with a backup, and a second run does nothing", () => {
    const files = [join(config, "settings.json"), join(root, ".claude", "settings.json"), join(root, ".claude", "settings.local.json")];
    for (const file of files) put(file, ORIGINAL);
    if (POSIX) chmodSync(files[0] ?? "", 0o600);

    const first = apply();

    expect(REWRITTEN).not.toBe(ORIGINAL);
    expect(REWRITTEN).toContain("oh-my-claudeagent:sisyphus-junior");
    expect(REWRITTEN).toContain("oh-my-claudeagent:explorer\", \"oh-my-claudeagent:explorer\"");
    for (const file of files) {
      expect(read(file)).toBe(REWRITTEN);
      expect(read(`${file}${BACKUP}`)).toBe(ORIGINAL);
    }
    if (POSIX) expect(statSync(files[0] ?? "").mode & 0o777).toBe(0o600);
    expect(first.actions.filter(({ kind }) => kind === "rewrite").map(({ from }) => from)).toEqual(files);
    expect(readdirSync(config).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    const second = apply();

    expect(second).toEqual(EMPTY);
    for (const file of files) {
      expect(read(file)).toBe(REWRITTEN);
      expect(read(`${file}${BACKUP}`)).toBe(ORIGINAL);
    }
  });

  test("an existing backup is kept and the new one takes an epoch suffix", () => {
    const file = put(join(root, ".claude", "settings.json"), ORIGINAL);
    put(`${file}${BACKUP}`, "keep me");

    apply();

    expect(read(`${file}${BACKUP}`)).toBe("keep me");
    const extra = readdirSync(dirname(file)).filter((name) => name.startsWith(`settings.json${BACKUP}.`));
    expect(extra).toHaveLength(1);
    expect(read(join(dirname(file), extra[0] ?? ""))).toBe(ORIGINAL);
  });

  test("a symlinked file is rewritten at its real path, the link stays, and the backup sits beside the real file", () => {
    if (!POSIX) return;
    const real = put(join(base, "dotfiles", "settings.json"), ORIGINAL);
    const link = join(root, ".claude", "settings.json");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(real, link);

    const report = apply();

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(real);
    expect(read(real)).toBe(REWRITTEN);
    expect(readdirSync(dirname(real)).sort()).toEqual(["settings.json", `settings.json${BACKUP}`]);
    expect(report.actions.map(({ kind, from }) => [kind, from])).toContainEqual(["rewrite", real]);
  });

  test("an unreadable file is left untouched and reported, and a missing one is skipped silently", () => {
    const binary = join(config, "settings.json");
    mkdirSync(config, { recursive: true });
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe, 0xfd]), Buffer.from(' "oh-my-claudeagent:sisyphus"')]);
    writeFileSync(binary, bytes);
    const directory = join(root, ".claude", "settings.local.json");
    mkdirSync(directory, { recursive: true });

    const report = apply();

    expect(readFileSync(binary).equals(bytes)).toBe(true);
    expect(readdirSync(config)).toEqual(["settings.json"]);
    expect(report.actions).toEqual([]);
    expect(report.mentions.map(({ path }) => path).sort()).toEqual([binary, directory].sort());
    for (const mention of report.mentions) expect(mention.reason).toContain("left untouched");
  });
});

describe("OpenCode configuration", () => {
  const JSONC = [
    "{",
    "  // keep this comment",
    '  "agent": { "omca-sisyphus": { "model": "x" }, "omca-explorer": {}, "omca-explore": {} },',
    '  "command": { "omca-hephaestus": {}, "omca-oracle-extra": {} } /* trailing */',
    "}",
    "",
  ].join("\n");
  const EXPECTED = JSONC.replace("omca-sisyphus", "omca-orchestrator").replace('"omca-explore": {}', '"omca-explorer": {}').replace("omca-hephaestus", "omca-build-fixer");

  test("agent and command ids are rewritten in place so a JSONC comment survives", () => {
    const file = put(join(root, "opencode.jsonc"), JSONC);
    const userFile = put(join(home, ".config", "opencode", "opencode.json"), '{"agent":{"omca-librarian":{}}}\n');

    apply();

    expect(read(file)).toBe(EXPECTED);
    expect(read(file)).toContain("// keep this comment");
    expect(read(file)).toContain("/* trailing */");
    expect(read(file)).toContain('"omca-oracle-extra"');
    expect(read(`${file}${BACKUP}`)).toBe(JSONC);
    expect(read(userFile)).toBe('{"agent":{"omca-researcher":{}}}\n');
    expect(apply()).toEqual(EMPTY);
  });

  test("XDG_CONFIG_HOME names the user configuration directory when it is set and absolute", () => {
    const xdg = join(base, "xdg");
    process.env["XDG_CONFIG_HOME"] = xdg;
    const inXdg = put(join(xdg, "opencode", "opencode.json"), '{"agent":"omca-momus"}\n');
    const inHome = put(join(home, ".config", "opencode", "opencode.json"), '{"agent":"omca-momus"}\n');

    apply();

    expect(read(inXdg)).toBe('{"agent":"omca-reviewer"}\n');
    expect(read(inHome)).toBe('{"agent":"omca-momus"}\n');
  });
});

describe("mentions", () => {
  test("files that name an old agent are listed and never edited", () => {
    const named = [
      put(join(root, "CLAUDE.md"), "Ask `sisyphus` first.\n"),
      put(join(root, ".claude", "agents", "mine.md"), "Delegate to oh-my-claudeagent:oracle.\n"),
      put(join(root, ".claude", "skills", "s", "SKILL.md"), "| momus | reviews |\n"),
      put(join(config, "projects", root.replace(/[^A-Za-z0-9]/g, "-"), "memory", "MEMORY.md"), "- uses omca-hephaestus\n"),
      put(join(home, ".config", "opencode", "agent", "a.md"), "Run omca-librarian.\n"),
    ];
    put(join(root, "AGENTS.md"), "Explore the repo, then ask the oracle of your choice.\n");
    put(join(root, ".claude", "commands", "c.md"), "Use oh-my-claudeagent:explorer and omca-reviewer.\n");
    put(join(root, ".claude", "agents", "junior.md"), "Use oh-my-claudeagent:sisyphus-junior.\n");
    const before = snapshot(base);

    const dry = run();
    const applied = apply();

    expect(snapshot(base)).toEqual(before);
    expect(dry.mentions.map(({ path }) => path).sort()).toEqual(named.sort());
    expect(applied.mentions).toEqual(dry.mentions);
    expect(applied.actions).toEqual([]);
  });
});

describe("agents_migrate", () => {
  const tool = tools[0];

  test("is declared as a destructive writer that takes apply, merge_indexes and working_directory", () => {
    expect(tool?.name).toBe("agents_migrate");
    expect(tool?.annotations).toEqual({ title: "Migrate agent names", readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["apply", "merge_indexes", "working_directory"]);
  });

  test("reports without writing by default, and applies only when asked", async () => {
    expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
    process.env["HOME"] = home;
    process.env["CLAUDE_CONFIG_DIR"] = config;
    put(join(root, ".claude", "settings.json"), '{"agent":"oh-my-claudeagent:prometheus"}\n');
    put(join(projectMemory("prometheus"), "MEMORY.md"), "- p\n");
    const before = snapshot(base);

    const dry = JSON.parse(String(await tool?.call({ working_directory: root })));
    expect(snapshot(base)).toEqual(before);
    expect(dry.actions.map(({ kind }: { kind: string }) => kind)).toEqual(["move-dir", "backup", "rewrite"]);
    expect(dry.collisions).toEqual([]);

    await tool?.call({ working_directory: root, apply: true });
    expect(read(join(projectMemory("planner"), "MEMORY.md"))).toBe("- p\n");
    expect(read(join(root, ".claude", "settings.json"))).toBe('{"agent":"oh-my-claudeagent:planner"}\n');
  });

  test("rejects an apply that is not a boolean", () => {
    expect(() => tool?.call({ apply: "yes" })).toThrow("agents_migrate: apply must be a boolean");
  });
});
