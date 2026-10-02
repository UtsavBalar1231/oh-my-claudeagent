import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fakeExec } from "../../tests/fixtures/fake-exec.ts";
import { setPath } from "../../tests/fixtures/spec-env.ts";
import { discoverBinary, extensionMismatch, gitWorktreeRoots, patternWarning, resolveNative, run, tools } from "./ast.ts";

const ENV_KEYS = ["PATH", "AST_GREP_BIN", "CLAUDE_PROJECT_DIR"] as const;
const MAIN_PY = "print('hello')\nx = 1\nold_func(x)\n";
const INSTALL_HINT =
  "ast-grep binary not found (looked for $AST_GREP_BIN, ast-grep and sg on PATH).\n\nInstall options:\n  cargo install ast-grep --locked\n  brew install ast-grep\n  npm install -g @ast-grep/cli\n  pacman -S ast-grep\n  pip install ast-grep-cli\n  scoop install main/ast-grep";
const CAPPED = "[TRUNCATED] Output exceeded AST MCP caps\n\n";
const NO_RULE_MATCH =
  "No matches found.\n\nHint: If using relational rules (has, inside, follows, precedes), try adding `stopBy: end` to search the entire subtree.";
const CPP_ON_C_FILE =
  "None of the given file path(s) have an extension mapped to lang='cpp'. ast-grep filters files by language extension, so it likely scanned nothing. Check that lang matches the files' type.";
const rule = (id: string, severity: string, pattern: string) =>
  `id: ${id}\nlanguage: python\nseverity: ${severity}\nrule:\n  pattern: ${pattern}\n`;

const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
const dirs: string[] = [];

beforeEach(() => {
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value === undefined) delete savedEnv[key];
    else savedEnv[key] = value;
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "omca-ast-")));
  dirs.push(dir);
  return dir;
}

function project(files: Record<string, string> = {}): string {
  const dir = tempDir();
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  process.env.CLAUDE_PROJECT_DIR = dir;
  return dir;
}

type Reply = { stdout?: string; stderr?: string; exit?: number };

function fakeBinary(replies: Reply[] = []) {
  const dir = tempDir();
  replies.forEach(({ stdout, stderr, exit }, index) => {
    const n = index + 1;
    if (stdout !== undefined) writeFileSync(join(dir, `stdout.${n}`), stdout);
    if (stderr !== undefined) writeFileSync(join(dir, `stderr.${n}`), stderr);
    if (exit !== undefined) writeFileSync(join(dir, `exit.${n}`), String(exit));
  });
  process.env.AST_GREP_BIN = fakeExec(
    dir,
    "ast-grep",
    [
      'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      `const dir = ${JSON.stringify(dir)};`,
      "const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : undefined);",
      "const n = Number(read('count') ?? 0) + 1;",
      "writeFileSync(join(dir, 'count'), String(n));",
      "writeFileSync(join(dir, `argv.${n}`), process.argv.slice(2).map((arg) => `${arg}\\0`).join(''));",
      "writeFileSync(join(dir, `stdin.${n}`), await Bun.stdin.text());",
      "const stderr = read(`stderr.${n}`);",
      "if (stderr !== undefined) process.stderr.write(stderr);",
      "const stdout = read(`stdout.${n}`);",
      "if (stdout !== undefined) process.stdout.write(stdout);",
      "process.exitCode = Number(read(`exit.${n}`) ?? 0);",
    ].join("\n"),
  );
  const argv = (n: number) => readFileSync(join(dir, `argv.${n}`), "utf8").split("\0").slice(0, -1);
  return {
    calls: () => Number(readFileSync(join(dir, "count"), "utf8")),
    argv,
    stdin: (n: number) => readFileSync(join(dir, `stdin.${n}`), "utf8"),
  };
}

function git(cwd: string, ...args: string[]): void {
  const identity = ["-c", "user.name=spec", "-c", "user.email=spec@example.com", "-c", "commit.gpgsign=false"];
  expect(Bun.spawnSync(["git", ...identity, ...args], { cwd, env: process.env }).exitCode).toBe(0);
}

function repoWithWorktree(): { main: string; linked: string } {
  const base = tempDir();
  const main = join(base, "main");
  const linked = join(base, "feature");
  mkdirSync(main);
  git(main, "init", "-q");
  git(main, "commit", "-q", "--allow-empty", "-m", "init");
  git(main, "worktree", "add", "-q", "-b", "feature", linked);
  return { main, linked };
}

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool.call(args);
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to fail");
}

const match = (file: string, line: number, text: string, extra: object = {}) => ({
  file,
  lines: text,
  range: { start: { line, column: 0 } },
  ...extra,
});
const matchesJson = (count: number) =>
  JSON.stringify(Array.from({ length: count }, (_, i) => match(`f${i}.py`, 0, "old_func(x)")));

describe("declarations", () => {
  test("the five tools are declared in order, ast_replace alone writes, ast_search alone raises the result cap", () => {
    expect(tools.map((tool) => tool.name)).toEqual([
      "ast_search",
      "ast_replace",
      "ast_find_rule",
      "ast_dump_tree",
      "ast_test_rule",
    ]);
    expect(tools.filter((tool) => !tool.annotations.readOnlyHint).map((tool) => tool.name)).toEqual(["ast_replace"]);
    expect(tools.filter((tool) => tool.annotations.destructiveHint !== undefined).map((tool) => tool.name)).toEqual([
      "ast_replace",
    ]);
    expect(tools.filter((tool) => tool._meta?.["anthropic/maxResultSizeChars"] !== undefined).map((tool) => tool.name)).toEqual([
      "ast_search",
    ]);
  });
});

describe("binary discovery", () => {
  test("with no binary on PATH every tool returns the error naming ast-grep and how to install it", async () => {
    project({ "main.py": MAIN_PY });
    delete process.env.AST_GREP_BIN;
    setPath("");
    const calls: Array<[string, Record<string, unknown>]> = [
      ["ast_search", { pattern: "print($$$A)", lang: "python" }],
      ["ast_replace", { pattern: "old_func($X)", rewrite: "new_func($X)", lang: "python" }],
      ["ast_find_rule", { rule_yaml: rule("r", "info", "print($$$A)") }],
      ["ast_dump_tree", { code: "x = 1", language: "python" }],
      ["ast_test_rule", { code: "x = 1", rule_yaml: rule("r", "info", "print($$$A)") }],
    ];
    for (const [name, args] of calls) expect(await failure(call(name, args))).toBe(INSTALL_HINT);
  });

  test("$AST_GREP_BIN wins over a binary on PATH", () => {
    const dir = tempDir();
    fakeExec(dir, "ast-grep", 'console.log("ast-grep 1.0.0");');
    setPath(dir);
    const configured = fakeExec(dir, "configured", 'console.log("configured");');
    process.env.AST_GREP_BIN = configured;
    expect(discoverBinary()).toBe(configured);
  });

  test("an unusable $AST_GREP_BIN is reported and discovery falls back to PATH", () => {
    const dir = tempDir();
    const found = fakeExec(dir, "ast-grep", 'console.log("ast-grep 1.0.0");');
    setPath(dir);
    process.env.AST_GREP_BIN = join(dir, "missing");
    const warn = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(discoverBinary()).toBe(found);
      expect(warn).toHaveBeenCalledWith(`omca: $AST_GREP_BIN=${join(dir, "missing")} not found in PATH`);
    } finally {
      warn.mockRestore();
    }
  });

  test("sg is used only when it identifies itself as ast-grep", () => {
    const dir = tempDir();
    delete process.env.AST_GREP_BIN;
    setPath(dir);
    fakeExec(dir, "sg", 'console.log("newgrp 4.18");');
    expect(() => discoverBinary()).toThrow(INSTALL_HINT);
    const sg = fakeExec(dir, "sg", 'console.log("ast-grep 0.45.3");');
    expect(discoverBinary()).toBe(sg);
  });
});

describe("Windows shims", () => {
  const layout = (...files: string[]) => {
    const dir = tempDir();
    for (const file of files) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), "");
    }
    return dir;
  };
  const CLI = join("node_modules", "@ast-grep", "cli");

  test.each(["ast-grep.cmd", "AST-GREP.CMD", "ast-grep.bat", "ast-grep.ps1"])("%s resolves to the native binary beside it", (shim) => {
    const dir = layout(shim, join(CLI, "ast-grep.exe"));
    expect(resolveNative(join(dir, shim), "win32")).toBe(join(dir, CLI, "ast-grep.exe"));
  });

  test("sg.cmd resolves to sg.exe", () => {
    const dir = layout("sg.cmd", join(CLI, "sg.exe"), join(CLI, "ast-grep.exe"));
    expect(resolveNative(join(dir, "sg.cmd"), "win32")).toBe(join(dir, CLI, "sg.exe"));
  });

  test("a shim with no native binary beside it is refused with cargo, pip and scoop routes", () => {
    const dir = layout("ast-grep.cmd", join(CLI, "package.json"));
    const refusal = () => resolveNative(join(dir, "ast-grep.cmd"), "win32");
    expect(refusal).toThrow("a batch shim");
    expect(refusal).toThrow("no ast-grep.exe sits beside it");
    for (const route of ["cargo install ast-grep --locked", "pip install ast-grep-cli", "scoop install main/ast-grep"]) {
      expect(refusal).toThrow(route);
    }
  });

  test("an .exe, and any path off Windows, is returned untouched", () => {
    const dir = layout("ast-grep.cmd");
    expect(resolveNative("C:\\tools\\ast-grep.exe", "win32")).toBe("C:\\tools\\ast-grep.exe");
    expect(resolveNative(join(dir, "ast-grep.cmd"), "linux")).toBe(join(dir, "ast-grep.cmd"));
    expect(resolveNative(join(dir, "ast-grep.cmd"), "darwin")).toBe(join(dir, "ast-grep.cmd"));
  });
});

describe("timeout", () => {
  test("a process that outlives the limit is killed and reported by elapsed time, with no signalCode needed", async () => {
    project();
    const dir = tempDir();
    process.env.AST_GREP_BIN = fakeExec(dir, "ast-grep", "await Bun.sleep(5000);");
    const started = performance.now();
    await expect(run(["run"], { timeoutMs: 200 })).rejects.toThrow("Command timed out after 0.2s");
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  test("a process that finishes inside the limit is not reported as timed out", async () => {
    project();
    const dir = tempDir();
    process.env.AST_GREP_BIN = fakeExec(dir, "ast-grep", 'console.log("[]");');
    expect((await run(["run"], { timeoutMs: 5_000 })).stdout.length).toBeGreaterThan(0);
  });
});

describe("ast_search", () => {
  test("ast_search returns parsed results", async () => {
    project({ "main.py": MAIN_PY });
    expect(await call("ast_search", { pattern: "print($$$A)", lang: "python" })).toBe(
      "Found 1 match(es):\n\nmain.py:1:1\n  print('hello')\n",
    );
  });

  test("ast_search treats a pattern that starts with a hyphen as a pattern, not an option", async () => {
    project({ "n.ts": "const y = -x;\n" });
    expect(await call("ast_search", { pattern: "-$X", lang: "typescript" })).toBe(
      "Found 1 match(es):\n\nn.ts:1:11\n  const y = -x;\n",
    );
  });

  test("ast_search inserts path separator and defaults paths", async () => {
    project();
    const fake = fakeBinary([{ stdout: "[]" }, { stdout: "[]" }]);
    await call("ast_search", { pattern: "print($$$A)", lang: "python" });
    expect(fake.argv(1)).toEqual(["run", "--pattern=print($$$A)", "--lang", "python", "--json=compact", "--", "."]);
    await call("ast_search", {
      pattern: "print($$$A)",
      lang: "python",
      paths: ["src"],
      globs: ["!*.test.py"],
      context: 2,
    });
    expect(fake.argv(2)).toEqual([
      "run",
      "--pattern=print($$$A)",
      "--lang",
      "python",
      "--json=compact",
      "-C",
      "2",
      "--globs=!*.test.py",
      "--",
      "src",
    ]);
  });

  test("ast_search no matches", async () => {
    project({ "main.py": MAIN_PY });
    expect(await call("ast_search", { pattern: "nonexistent_pattern()", lang: "python" })).toBe("No matches found");
  });

  test("ast_search no match hints regex patterns", async () => {
    project();
    fakeBinary([{ exit: 1 }]);
    expect(await call("ast_search", { pattern: "foo|bar", lang: "python" })).toBe(
      "No matches found\n\nHints:\n- Regex alternation with | does not work in ast-grep patterns. Run separate AST searches or switch to grep.",
    );
  });

  test("ast_search no match hints C bare call", async () => {
    project();
    fakeBinary([{ exit: 1 }]);
    expect(await call("ast_search", { pattern: "lapis_record_set_outcome($$$)", lang: "c" })).toBe(
      "No matches found\n\nHints:\n- In C a bare call pattern like `name($$$)` parses as a type/macro (macro_type_specifier), not a function call, so it never matches real call sites and silently returns nothing. Use ast_find_rule with `kind: call_expression` (match the name via `has: {field: function, regex: '^name$'}`), or a pattern object giving expression context: `context: 'int v = name($$$);'` with `selector: call_expression`.",
    );
  });

  test("ast_search surfaces error node warning", async () => {
    project();
    fakeBinary([
      {
        stderr:
          "Warning: Pattern contains an ERROR node and may cause unexpected results.\n" +
          "Help: ast-grep parsed the pattern but it matched nothing in this run.\n" +
          "See also: https://ast-grep.github.io/playground.html\n",
      },
    ]);
    expect(await call("ast_search", { pattern: "target($$$)", lang: "solidity" })).toBe(
      "No matches found\n\nWarning: Pattern contains an ERROR node and may cause unexpected results. Replace literal sub-parts with metavariables ($VAR / $$$), or use ast_find_rule with an explicit `kind:`.",
    );
  });

  test("ast_search extension mismatch hint", async () => {
    project({ "x.c": "int main(){ return 0; }\n" });
    fakeBinary([{ exit: 1 }]);
    expect(await call("ast_search", { pattern: "return $X", lang: "cpp", paths: ["x.c"] })).toBe(
      `No matches found\n\n${CPP_ON_C_FILE}`,
    );
  });

  test("ast_search hard parse error raises", async () => {
    project();
    fakeBinary([{ exit: 8, stderr: "Error: Cannot parse query as a valid pattern.\nHelp: fix the pattern.\n" }]);
    expect(await failure(call("ast_search", { pattern: "greet() { $$$ }", lang: "bash" }))).toBe(
      "ast-grep error (exit 8): Error: Cannot parse query as a valid pattern.\nHelp: fix the pattern.",
    );
  });

  test("ast_search wellformed zero stays clean", async () => {
    project();
    fakeBinary([{ exit: 1 }]);
    expect(await call("ast_search", { pattern: "missing($$$)", lang: "python" })).toBe("No matches found");
  });

  test("pattern_warning strips noise", () => {
    const stderr =
      "Warning: Pattern contains an ERROR node and may cause unexpected results.\nHelp: x\nSee also: https://example\n";
    expect(patternWarning(stderr)).toBe("Warning: Pattern contains an ERROR node and may cause unexpected results.");
    expect(patternWarning("")).toBeUndefined();
    expect(patternWarning("ERROR: file: No such file\n")).toBeUndefined();
  });

  test("extension_mismatch skips directories", () => {
    project({ "x.c": "int x;\n" });
    expect(extensionMismatch(["."], "cpp")).toBeUndefined();
    expect(extensionMismatch(["x.c"], "c")).toBeUndefined();
    expect(extensionMismatch(["x.c"], "cpp")).toBe(CPP_ON_C_FILE);
  });

  test("ast_search rejects unsafe paths", async () => {
    project();
    const search = (path: string) => failure(call("ast_search", { pattern: "$X", lang: "python", paths: [path] }));
    expect(await search("")).toBe("Path entries must not be empty");
    expect(await search("bad\0path")).toBe("Path entries must not contain null bytes");
    expect(await search("-danger")).toBe("Path entries must not start with '-'");
    expect(await search("../outside")).toBe("Path escapes workspace: ../outside");
  });

  test("ast_search normalizes absolute workspace paths", async () => {
    const workspace = project({ "src/a.py": "x = 1\n" });
    const fake = fakeBinary([{ stdout: "[]" }]);
    await call("ast_search", { pattern: "$X", lang: "python", paths: [join(workspace, "src")] });
    expect(fake.argv(1).slice(-2)).toEqual(["--", "src"]);
  });

  test("ast_search accepts sibling git worktree", async () => {
    const { main, linked } = repoWithWorktree();
    mkdirSync(join(linked, "src"));
    process.env.CLAUDE_PROJECT_DIR = main;
    const fake = fakeBinary([{ stdout: "[]" }]);
    const target = join(linked, "src");
    await call("ast_search", { pattern: "$X", lang: "python", paths: [target] });
    expect(fake.argv(1).slice(-2)).toEqual(["--", target]);
  });

  test("ast_search rejects path outside every worktree", async () => {
    const { main } = repoWithWorktree();
    process.env.CLAUDE_PROJECT_DIR = main;
    const outside = tempDir();
    expect(await failure(call("ast_search", { pattern: "$X", lang: "python", paths: [outside] }))).toBe(
      `Path escapes workspace: ${outside}`,
    );
  });

  test("git_worktree_roots parses porcelain output", () => {
    const { main, linked } = repoWithWorktree();
    expect(gitWorktreeRoots(main)).toEqual([main, linked]);
  });

  test("git_worktree_roots empty outside a repository", () => {
    expect(gitWorktreeRoots(tempDir())).toEqual([]);
  });

  test.skipIf(process.platform === "win32")("ast_search rejects symlink escape (skipped on Windows: creating a symlink needs a privilege)", async () => {
    const workspace = project();
    symlinkSync(tempDir(), join(workspace, "escape"), "dir");
    expect(await failure(call("ast_search", { pattern: "$X", lang: "python", paths: ["escape"] }))).toBe(
      "Path resolves outside workspace: escape",
    );
  });

  test("ast_search truncated json recovers complete objects", async () => {
    project();
    const first = match("one.py", 0, "print('one')");
    const second = match("two.py", 1, "x".repeat(2 * 1024 * 1024));
    fakeBinary([{ stdout: `[${JSON.stringify(first)},${JSON.stringify(second)}]` }]);
    expect(await call("ast_search", { pattern: "print($$$A)", lang: "python" })).toBe(
      `${CAPPED}Found 1 match(es):\n\none.py:1:1\n  print('one')\n`,
    );
  });

  test("ast_search output over the cap with no complete object is a tool error", async () => {
    project();
    fakeBinary([{ stdout: `[${JSON.stringify(match("one.py", 0, "x".repeat(2 * 1024 * 1024)))}]` }]);
    expect(await failure(call("ast_search", { pattern: "$X", lang: "python" }))).toBe(
      "ast-grep JSON output exceeded 1 MiB and could not be parsed through a complete result",
    );
  });

  test("ast_search caps the result at 500 matches and says so", async () => {
    project();
    fakeBinary([{ stdout: matchesJson(501) }]);
    const result = await call("ast_search", { pattern: "$X", lang: "python" });
    expect(result).toStartWith(`${CAPPED}Found 500 match(es):\n\nf0.py:1:1\n  old_func(x)\n\nf1.py:1:1\n`);
    expect(result.match(/^f\d+\.py:1:1$/gm)).toHaveLength(500);
  });

  test("ast_search max_results lowers the cap and marks the truncation", async () => {
    project();
    fakeBinary([{ stdout: matchesJson(2) }]);
    expect(await call("ast_search", { pattern: "$X", lang: "python", max_results: 1 })).toBe(
      "[TRUNCATED] Showing first 1 of 2 matches\n\nFound 1 match(es):\n\nf0.py:1:1\n  old_func(x)\n",
    );
  });

  test("ast_search json output returns the matches as JSON", async () => {
    project();
    const hit = match("main.py", 0, "print('hello')");
    fakeBinary([{ stdout: JSON.stringify([hit, hit]) }]);
    const result = await call("ast_search", { pattern: "$X", lang: "python", output_format: "json", max_results: 1 });
    expect(JSON.parse(result)).toEqual([hit]);
  });

  test("ast_search json parse errors are tool errors", async () => {
    project();
    fakeBinary([{ stdout: "not json" }, { stdout: "{}" }]);
    const search = () => failure(call("ast_search", { pattern: "$X", lang: "python" }));
    expect(await search()).toStartWith("Failed to parse ast-grep JSON output: ");
    expect(await search()).toBe("Failed to parse ast-grep JSON output: expected a JSON array");
  });

  test("ast_search subprocess error", async () => {
    project();
    fakeBinary([{ exit: 2, stderr: "fatal: something went wrong" }]);
    expect(await failure(call("ast_search", { pattern: "$X", lang: "python" }))).toBe(
      "ast-grep error (exit 2): fatal: something went wrong",
    );
  });

  test("ast_search rejects an argument of the wrong type before running anything", async () => {
    project();
    expect(await failure(call("ast_search", { pattern: "$X", lang: "cobol" }))).toBe(
      "ast_search: lang must be one of bash, c, cpp, csharp, css, elixir, go, haskell, html, java, javascript, json, kotlin, lua, nix, php, python, ruby, rust, scala, solidity, swift, typescript, tsx, yaml",
    );
    expect(await failure(call("ast_search", { lang: "python" }))).toBe("ast_search: pattern must be a string");
    expect(await failure(call("ast_search", { pattern: "$X", lang: "python", paths: "src" }))).toBe(
      "ast_search: paths must be an array of strings",
    );
    expect(await failure(call("ast_search", { pattern: "$X", lang: "python", context: 1.5 }))).toBe(
      "ast_search: context must be an integer",
    );
  });
});

describe("ast_replace", () => {
  test("ast_replace dry run shows the rewritten text and writes nothing", async () => {
    const workspace = project({ "main.py": MAIN_PY });
    expect(await call("ast_replace", { pattern: "old_func($X)", rewrite: "new_func($X)", lang: "python" })).toBe(
      "[DRY RUN] 1 replacement(s):\n\nmain.py:3:1\n  old_func(x)\n  -> new_func(x)\n\nUse dry_run=false to apply changes",
    );
    expect(readFileSync(join(workspace, "main.py"), "utf8")).toBe(MAIN_PY);
  });

  test("ast_replace no matches", async () => {
    project({ "main.py": MAIN_PY });
    expect(await call("ast_replace", { pattern: "no_such_func($X)", rewrite: "other_func($X)", lang: "python" })).toBe(
      "No matches found to replace",
    );
  });

  test("ast_replace apply rewrites the file and reports the replacements", async () => {
    const workspace = project({ "main.py": MAIN_PY });
    expect(
      await call("ast_replace", { pattern: "old_func($X)", rewrite: "new_func($X)", lang: "python", dry_run: false }),
    ).toBe("1 replacement(s):\n\nmain.py:3:1\n  old_func(x)\n  -> new_func(x)\n");
    expect(readFileSync(join(workspace, "main.py"), "utf8")).toBe("print('hello')\nx = 1\nnew_func(x)\n");
  });

  test("ast_replace apply uses two pass commands", async () => {
    project();
    const fake = fakeBinary([{ stdout: JSON.stringify([match("app.py", 0, "old_func(x)")]) }]);
    await call("ast_replace", { pattern: "old_func($X)", rewrite: "new_func($X)", lang: "python", dry_run: false });
    const target = ["--pattern=old_func($X)", "--rewrite=new_func($X)", "--lang", "python"];
    expect(fake.argv(1)).toEqual(["run", ...target, "--json=compact", "--", "."]);
    expect(fake.argv(2)).toEqual(["run", ...target, "--update-all", "--", "."]);
  });

  test("ast_replace apply refused when truncated", async () => {
    project();
    const fake = fakeBinary([{ stdout: matchesJson(501) }]);
    expect(
      await failure(
        call("ast_replace", { pattern: "old_func($X)", rewrite: "new_func($X)", lang: "python", dry_run: false }),
      ),
    ).toBe(
      "Refusing to apply: matches exceed the 500-result preview cap, so --update-all would rewrite files the dry run did not show. Narrow the scope with paths/globs or a more specific pattern until the full change set previews, then re-run with dry_run=false.",
    );
    expect(fake.calls()).toBe(1);
  });

  test("ast_replace apply failure reports replace failed", async () => {
    project();
    fakeBinary([{ stdout: JSON.stringify([match("app.py", 0, "old_func(x)")]) }, { exit: 2, stderr: "write failed" }]);
    expect(
      await failure(
        call("ast_replace", { pattern: "old_func($X)", rewrite: "new_func($X)", lang: "python", dry_run: false }),
      ),
    ).toBe("Replace failed: ast-grep error (exit 2): write failed");
  });
});

describe("ast_find_rule", () => {
  test("ast_find_rule returns results", async () => {
    project({ "main.py": MAIN_PY });
    expect(await call("ast_find_rule", { rule_yaml: rule("find-imports", "info", "print($$$A)") })).toBe(
      "Found 1 match(es):\n\nmain.py:1:1 [find-imports] (info)\n  print('hello')\n",
    );
  });

  test("ast_find_rule returns matches of a rule whose severity is error", async () => {
    project({ "main.py": MAIN_PY });
    expect(await call("ast_find_rule", { rule_yaml: rule("no-print", "error", "print($$$A)") })).toBe(
      "Found 1 match(es):\n\nmain.py:1:1 [no-print] (error)\n  print('hello')\n",
    );
  });

  test("ast_find_rule inserts path separator", async () => {
    project();
    const fake = fakeBinary([{ stdout: "[]" }]);
    const yaml = rule("noop", "info", "doesnt_exist()");
    await call("ast_find_rule", { rule_yaml: yaml });
    expect(fake.argv(1)).toEqual(["scan", `--inline-rules=${yaml}`, "--json=compact", "--", "."]);
  });

  test("ast_find_rule no matches", async () => {
    project({ "main.py": MAIN_PY });
    expect(await call("ast_find_rule", { rule_yaml: rule("noop", "info", "doesnt_exist()") })).toBe("No matches found");
  });

  test("ast_find_rule hands an invalid rule to ast-grep unparsed", async () => {
    project({ "main.py": MAIN_PY });
    expect(await failure(call("ast_find_rule", { rule_yaml: "id: [unclosed\n" }))).toStartWith(
      "ast-grep error (exit 8): Error: Cannot parse rule INLINE_RULES",
    );
  });
});

describe("ast_dump_tree", () => {
  test("ast_dump_tree returns tree", async () => {
    project();
    expect(await call("ast_dump_tree", { code: "print('hello')", language: "python", format: "cst" })).toStartWith(
      "Debug CST:\nmodule (0,0)-(0,14)\n  expression_statement (0,0)-(0,14)\n    call (0,0)-(0,14)\n",
    );
  });

  test("ast_dump_tree empty output", async () => {
    project();
    const fake = fakeBinary();
    expect(await call("ast_dump_tree", { code: "print('x')", language: "python", format: "ast" })).toBe(
      "No syntax tree output. The code may be empty or unparseable.",
    );
    expect(fake.argv(1)).toEqual(["run", "--pattern=print('x')", "--lang", "python", "--debug-query=ast", "--stdin"]);
    expect(fake.stdin(1)).toBe("print('x')");
  });
});

describe("ast_test_rule", () => {
  test("ast_test_rule returns matches", async () => {
    project();
    expect(await call("ast_test_rule", { code: "print('x')", rule_yaml: rule("test", "info", "print($$$A)") })).toBe(
      "Found 1 match(es):\n\nSTDIN:1:1 [test] (info)\n  print('x')\n",
    );
  });

  test("ast_test_rule no match", async () => {
    project();
    expect(await call("ast_test_rule", { code: "print('x')", rule_yaml: rule("test", "info", "doesnt_match()") })).toBe(
      NO_RULE_MATCH,
    );
  });

  test("ast_test_rule feeds the snippet on stdin and the rule inline", async () => {
    project();
    const fake = fakeBinary([{ stdout: "[]" }]);
    const yaml = rule("test", "info", "print($$$A)");
    await call("ast_test_rule", { code: "print('x')", rule_yaml: yaml });
    expect(fake.argv(1)).toEqual(["scan", `--inline-rules=${yaml}`, "--stdin", "--json=compact"]);
    expect(fake.stdin(1)).toBe("print('x')");
  });
});
