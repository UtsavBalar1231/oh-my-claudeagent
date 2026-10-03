import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUN_NAME, homeEnv, specEnv, symlinkOrCopy } from "../tests/fixtures/spec-env.ts";

const REPO = join(import.meta.dir, "..");
const SCRIPT = join(REPO, "scripts", "setup-statusline.ts");
const LAUNCHER_SOURCE = join(REPO, "statusline", "launcher.ts");
const FIXTURES = join(REPO, "tests", "fixtures", "settings");

const posix = (path: string): string => path.replaceAll("\\", "/");

let root = "";
let home = "";
let bun = "";
let launcher = "";
let settings = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omca-setup-"));
  home = join(root, "home");
  bun = join(root, "bin", BUN_NAME);
  launcher = join(home, ".claude", "omca", "statusline.ts");
  settings = join(root, "settings.json");
  mkdirSync(join(root, "bin"));
  mkdirSync(home);
  symlinkOrCopy(process.execPath, bun);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function fixtureText(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8").replaceAll("@BUN@", posix(bun)).replaceAll("@HOME@", posix(home));
}

function fixture(name: string): string {
  const text = fixtureText(name);
  writeFileSync(settings, text);
  return text;
}

function runWith(env: Record<string, string | undefined>, ...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync([process.execPath, SCRIPT, "--settings", settings, ...args], { env: specEnv({ CLAUDE_CONFIG_DIR: undefined, ...env }), stdin: "ignore" });
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode };
}

const run = (...args: string[]) => runWith({ ...homeEnv(home), PATH: join(root, "bin") }, ...args);

const command = (program = bun, script = launcher, flags = "") => `\\"${posix(program)}\\" \\"${posix(script)}\\"${flags}`;

const statusLine = (indent: string) =>
  [
    `"statusLine": {`,
    `${indent}"type": "command",`,
    `${indent}"command": "${command()}",`,
    `${indent}"padding": 1,`,
    `${indent}"refreshInterval": 5,`,
    `${indent}"hideVimModeIndicator": true`,
    `}`,
  ];

const subagentStatusLine = (indent: string) =>
  [`"subagentStatusLine": {`, `${indent}"type": "command",`, `${indent}"command": "${command(bun, launcher, " --subagent")}"`, `}`];

const header = () => [`--- ${settings}`, `+++ ${settings}`];
const copyLine = () => `copy ${LAUNCHER_SOURCE} to ${launcher}`;
const NOT_WRITTEN = "Nothing was written. Run again with --yes to apply.";

const NO_STATUSLINE_AFTER = () =>
  [
    "{",
    '  "permissions": {',
    '    "allow": ["Read(.omca/**)", "Edit(.omca/**)"]',
    "  },",
    '  "enabledPlugins": {',
    '    "oh-my-claudeagent@omca": true',
    "  },",
    '  "theme": "dark",',
    ...statusLine("  ").map((line, i, all) => `  ${line}${i === all.length - 1 ? "," : ""}`),
    ...subagentStatusLine("  ").map((line) => `  ${line}`),
    "}",
    "",
  ].join("\n");

const OTHER_STATUSLINE_AFTER = () =>
  [
    "{",
    '    "model": "opus",',
    ...statusLine("    ").map((line, i, all) => `    ${line}${i === all.length - 1 ? "," : ""}`),
    ...subagentStatusLine("    ").map((line, i, all) => `    ${line}${i === all.length - 1 ? "," : ""}`),
    '    "env": {',
    '        "FOO": "1"',
    "    }",
    "}",
    "",
  ].join("\n");

describe("install", () => {
  test("settings without a statusLine gain both entries after the last key", () => {
    const before = fixture("no-statusline.json");
    const diff = [
      ...header(),
      "@@ -5,5 +5,16 @@",
      '   "enabledPlugins": {',
      '     "oh-my-claudeagent@omca": true',
      "   },",
      '-  "theme": "dark"',
      '+  "theme": "dark",',
      ...NO_STATUSLINE_AFTER()
        .split("\n")
        .slice(8, 19)
        .map((line) => `+${line}`),
      " }",
    ];

    expect(run()).toEqual({ stdout: [...diff, copyLine(), NOT_WRITTEN, ""].join("\n"), stderr: "", exitCode: 0 });
    expect(readFileSync(settings, "utf8")).toBe(before);
    expect(existsSync(`${settings}.omca-bak`)).toBe(false);
    expect(existsSync(launcher)).toBe(false);

    expect(run("--yes")).toEqual({
      stdout: [...diff, copyLine(), `Wrote ${settings}; the previous version is ${settings}.omca-bak.`, `Installed ${launcher}.`, ""].join("\n"),
      stderr: "",
      exitCode: 0,
    });
    expect(readFileSync(settings, "utf8")).toBe(NO_STATUSLINE_AFTER());
    expect(readFileSync(`${settings}.omca-bak`, "utf8")).toBe(before);
    expect(readFileSync(launcher, "utf8")).toBe(readFileSync(LAUNCHER_SOURCE, "utf8"));
  });

  test("a settings file that starts with a byte-order mark is accepted and keeps the mark", () => {
    const bom = "\uFEFF";
    const before = bom + fixtureText("no-statusline.json");
    writeFileSync(settings, before);

    const preview = run();
    expect(preview).toMatchObject({ stderr: "", exitCode: 0 });
    expect(preview.stdout).toContain(`+${NO_STATUSLINE_AFTER().split("\n")[8]}`);
    expect(readFileSync(settings, "utf8")).toBe(before);

    expect(run("--yes").exitCode).toBe(0);
    expect(readFileSync(settings, "utf8")).toBe(bom + NO_STATUSLINE_AFTER());
    expect(readFileSync(`${settings}.omca-bak`, "utf8")).toBe(before);

    expect(run("--uninstall", "--yes").exitCode).toBe(0);
    expect(readFileSync(settings, "utf8").startsWith(bom)).toBe(true);
    expect(JSON.parse(readFileSync(settings, "utf8").slice(bom.length))).toEqual(JSON.parse(fixtureText("no-statusline.json")));
  });

  test("a statusLine pointing elsewhere is replaced in place, keeping the file's indentation", () => {
    const before = fixture("other-statusline.json");
    const diff = [
      ...header(),
      "@@ -2,7 +2,14 @@",
      '     "model": "opus",',
      '     "statusLine": {',
      '         "type": "command",',
      '-        "command": "~/bin/my-statusline.sh"',
      ...OTHER_STATUSLINE_AFTER()
        .split("\n")
        .slice(4, 12)
        .map((line) => `+${line}`),
      "     },",
      '     "env": {',
      '         "FOO": "1"',
    ];

    expect(run("--yes")).toEqual({
      stdout: [...diff, copyLine(), `Wrote ${settings}; the previous version is ${settings}.omca-bak.`, `Installed ${launcher}.`, ""].join("\n"),
      stderr: "",
      exitCode: 0,
    });
    expect(readFileSync(settings, "utf8")).toBe(OTHER_STATUSLINE_AFTER());
    expect(readFileSync(`${settings}.omca-bak`, "utf8")).toBe(before);
  });

  test("settings already running OMCA's launcher change nothing", () => {
    const before = fixture("omca-statusline.json");
    mkdirSync(join(home, ".claude", "omca"), { recursive: true });
    writeFileSync(launcher, readFileSync(LAUNCHER_SOURCE));

    expect(run("--yes")).toEqual({ stdout: `Already configured: ${settings} runs both status lines through ${launcher}.\n`, stderr: "", exitCode: 0 });
    expect(readFileSync(settings, "utf8")).toBe(before);
    expect(existsSync(`${settings}.omca-bak`)).toBe(false);
  });

  test("an entry written without quotes is upgraded to the quoted form, and a second run changes nothing", () => {
    const quoted = fixture("omca-statusline.json");
    const unquoted = fixture("omca-statusline-unquoted.json");
    expect(unquoted).not.toBe(quoted);
    mkdirSync(join(home, ".claude", "omca"), { recursive: true });
    writeFileSync(launcher, readFileSync(LAUNCHER_SOURCE));

    expect(run("--yes").exitCode).toBe(0);
    expect(readFileSync(settings, "utf8")).toBe(quoted);
    expect(readFileSync(`${settings}.omca-bak`, "utf8")).toBe(unquoted);
    expect(run("--yes")).toEqual({ stdout: `Already configured: ${settings} runs both status lines through ${launcher}.\n`, stderr: "", exitCode: 0 });
  });

  test("CLAUDE_CONFIG_DIR moves the launcher and the commands that name it", () => {
    fixture("no-statusline.json");
    const config = join(root, "my config");
    const moved = join(config, "omca", "statusline.ts");

    expect(runWith({ ...homeEnv(home), CLAUDE_CONFIG_DIR: config, PATH: join(root, "bin") }, "--yes").exitCode).toBe(0);
    const written = JSON.parse(readFileSync(settings, "utf8"));
    expect(written.statusLine.command).toBe(`"${posix(bun)}" "${posix(moved)}"`);
    expect(written.subagentStatusLine.command).toBe(`"${posix(bun)}" "${posix(moved)}" --subagent`);
    expect(readFileSync(moved, "utf8")).toBe(readFileSync(LAUNCHER_SOURCE, "utf8"));
    expect(existsSync(launcher)).toBe(false);
  });

  test("with HOME unset the launcher goes under USERPROFILE", () => {
    fixture("no-statusline.json");

    expect(runWith({ HOME: undefined, USERPROFILE: home, PATH: join(root, "bin") }, "--yes").exitCode).toBe(0);
    expect(readFileSync(launcher, "utf8")).toBe(readFileSync(LAUNCHER_SOURCE, "utf8"));
    expect(JSON.parse(readFileSync(settings, "utf8")).statusLine.command).toBe(`"${posix(bun)}" "${posix(launcher)}"`);
  });

  test("a program path with a space stays one quoted argument, and uninstall still recognizes the entry", () => {
    fixture("no-statusline.json");
    const spaced = join(root, "bun dir", BUN_NAME);
    mkdirSync(join(root, "bun dir"));
    symlinkOrCopy(process.execPath, spaced);
    const env = { ...homeEnv(home), PATH: join(root, "bun dir") };

    expect(runWith(env, "--yes").exitCode).toBe(0);
    expect(JSON.parse(readFileSync(settings, "utf8")).statusLine.command).toBe(`"${posix(spaced)}" "${posix(launcher)}"`);
    expect(runWith(env, "--uninstall", "--yes").exitCode).toBe(0);
    expect(readFileSync(settings, "utf8")).toBe(fixtureText("no-statusline.json"));
  });

  test("a missing launcher is installed without touching settings that already point at it", () => {
    const before = fixture("omca-statusline.json");

    expect(run("--yes")).toEqual({ stdout: [copyLine(), `Installed ${launcher}.`, ""].join("\n"), stderr: "", exitCode: 0 });
    expect(readFileSync(settings, "utf8")).toBe(before);
    expect(existsSync(`${settings}.omca-bak`)).toBe(false);
  });

  test("a missing settings file is created without a backup", () => {
    const created = ["{", ...statusLine("  ").map((line, i, all) => `  ${line}${i === all.length - 1 ? "," : ""}`), ...subagentStatusLine("  ").map((line) => `  ${line}`), "}", ""].join("\n");

    expect(run("--yes").exitCode).toBe(0);
    expect(readFileSync(settings, "utf8")).toBe(created);
    expect(existsSync(`${settings}.omca-bak`)).toBe(false);
  });

  test("the backup is written before the settings, so a failed backup leaves them untouched", () => {
    const before = fixture("no-statusline.json");
    mkdirSync(`${settings}.omca-bak`);

    const { stderr, exitCode } = run("--yes");
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/^omca setup: EISDIR: illegal operation on a directory, (?:open '.*settings\.json\.omca-bak'|write)\n$/);
    expect(readFileSync(settings, "utf8")).toBe(before);
  });
});

describe("refusals", () => {
  test("malformed JSON is refused with one line and nothing is written", () => {
    const before = fixture("malformed.json");
    let parseError = "";
    try {
      JSON.parse(before);
    } catch (error) {
      parseError = error instanceof Error ? error.message : "";
    }

    expect(run("--yes")).toEqual({ stdout: "", stderr: `omca setup: ${settings} is not valid JSON (${parseError}); nothing was written\n`, exitCode: 1 });
    expect(readFileSync(settings, "utf8")).toBe(before);
    expect(existsSync(`${settings}.omca-bak`)).toBe(false);
    expect(existsSync(launcher)).toBe(false);
  });

  test("a JSON value that is not an object is refused", () => {
    writeFileSync(settings, "[]\n");
    expect(run("--yes")).toEqual({ stdout: "", stderr: `omca setup: ${settings} does not hold a JSON object; nothing was written\n`, exitCode: 1 });
  });

  test("a missing --settings prints the usage", () => {
    const result = Bun.spawnSync([process.execPath, SCRIPT], { env: specEnv({ ...homeEnv(home), PATH: join(root, "bin") }) });
    expect(result.stderr.toString()).toBe("omca setup: usage: bun scripts/setup-statusline.ts --settings <path> [--glyphs nerd|unicode|ascii [--glyphs-only]] [--yes] [--uninstall]\n");
    expect(result.exitCode).toBe(2);
  });
});

describe("uninstall", () => {
  test("only OMCA's entries and the launcher are removed", () => {
    const before = fixture("omca-statusline.json");
    mkdirSync(join(home, ".claude", "omca"), { recursive: true });
    writeFileSync(launcher, readFileSync(LAUNCHER_SOURCE));
    const diff = [
      ...header(),
      "@@ -1,14 +1,3 @@",
      " {",
      ...before
        .split("\n")
        .slice(1, 12)
        .map((line) => `-${line}`),
      '   "theme": "dark"',
      " }",
    ];

    expect(run("--uninstall")).toEqual({ stdout: [...diff, `remove ${launcher}`, NOT_WRITTEN, ""].join("\n"), stderr: "", exitCode: 0 });
    expect(existsSync(launcher)).toBe(true);

    expect(run("--uninstall", "--yes").exitCode).toBe(0);
    expect(readFileSync(settings, "utf8")).toBe('{\n  "theme": "dark"\n}\n');
    expect(readFileSync(`${settings}.omca-bak`, "utf8")).toBe(before);
    expect(existsSync(launcher)).toBe(false);
  });

  test("entries written without quotes are removed too", () => {
    fixture("omca-statusline-unquoted.json");

    expect(run("--uninstall", "--yes").exitCode).toBe(0);
    expect(readFileSync(settings, "utf8")).toBe('{\n  "theme": "dark"\n}\n');
  });

  test("a statusLine that is not OMCA's is left alone", () => {
    const before = fixture("other-statusline.json");
    expect(run("--uninstall", "--yes")).toEqual({ stdout: `Nothing to remove: no OMCA status line in ${settings} and no ${launcher}.\n`, stderr: "", exitCode: 0 });
    expect(readFileSync(settings, "utf8")).toBe(before);
  });
});

describe("glyphs", () => {
  test("--glyphs-only adds OMCA_GLYPHS to env, keeps the other variables and leaves the status lines alone", () => {
    writeFileSync(settings, '{\n  "model": "opus",\n  "env": { "FOO": "1" }\n}\n');
    expect(run("--glyphs", "unicode", "--glyphs-only", "--yes").exitCode).toBe(0);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ model: "opus", env: { FOO: "1", OMCA_GLYPHS: "unicode" } });
    expect(existsSync(launcher)).toBe(false);
    expect(run("--glyphs", "unicode", "--glyphs-only").stdout).toBe(`Already configured: ${settings} sets OMCA_GLYPHS to unicode.\n`);
  });

  test("uninstall removes OMCA_GLYPHS and an env it leaves empty", () => {
    writeFileSync(settings, '{\n  "env": { "OMCA_GLYPHS": "ascii" }\n}\n');
    expect(run("--uninstall", "--yes").exitCode).toBe(0);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({});
  });

  test("an unknown tier, or --glyphs-only alone, prints the usage", () => {
    writeFileSync(settings, "{}\n");
    expect(run("--glyphs", "nerdy").stderr).toStartWith("omca setup: --glyphs takes nerd, unicode or ascii\n");
    expect(run("--glyphs-only").stderr).toStartWith("omca setup: --glyphs-only needs --glyphs and no --uninstall\n");
  });
});
