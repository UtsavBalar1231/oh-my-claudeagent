import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const SCRIPT = join(REPO, "scripts", "setup-statusline.ts");
const LAUNCHER_SOURCE = join(REPO, "statusline", "launcher.ts");
const FIXTURES = join(REPO, "tests", "fixtures", "settings");

let root = "";
let home = "";
let bun = "";
let launcher = "";
let settings = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omca-setup-"));
  home = join(root, "home");
  bun = join(root, "bin", "bun");
  launcher = join(home, ".claude", "omca", "statusline.ts");
  settings = join(root, "settings.json");
  mkdirSync(join(root, "bin"));
  mkdirSync(home);
  symlinkSync(process.execPath, bun);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function fixture(name: string): string {
  const text = readFileSync(join(FIXTURES, name), "utf8").replaceAll("@BUN@", bun).replaceAll("@HOME@", home);
  writeFileSync(settings, text);
  return text;
}

function run(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync([process.execPath, SCRIPT, "--settings", settings, ...args], {
    env: { HOME: home, PATH: join(root, "bin") },
    stdin: "ignore",
  });
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode };
}

const statusLine = (indent: string) =>
  [
    `"statusLine": {`,
    `${indent}"type": "command",`,
    `${indent}"command": "${bun} ${launcher}",`,
    `${indent}"padding": 1,`,
    `${indent}"refreshInterval": 5,`,
    `${indent}"hideVimModeIndicator": true`,
    `}`,
  ];

const subagentStatusLine = (indent: string) =>
  [`"subagentStatusLine": {`, `${indent}"type": "command",`, `${indent}"command": "${bun} ${launcher} --subagent"`, `}`];

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
    expect(stderr).toBe(`omca setup: EISDIR: illegal operation on a directory, open '${settings}.omca-bak'\n`);
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
    const result = Bun.spawnSync([process.execPath, SCRIPT], { env: { HOME: home, PATH: join(root, "bin") } });
    expect(result.stderr.toString()).toBe("omca setup: usage: bun scripts/setup-statusline.ts --settings <path> [--yes] [--uninstall]\n");
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

  test("a statusLine that is not OMCA's is left alone", () => {
    const before = fixture("other-statusline.json");
    expect(run("--uninstall", "--yes")).toEqual({ stdout: `Nothing to remove: no OMCA status line in ${settings} and no ${launcher}.\n`, stderr: "", exitCode: 0 });
    expect(readFileSync(settings, "utf8")).toBe(before);
  });
});
