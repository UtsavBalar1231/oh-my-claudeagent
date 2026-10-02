import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dispatch } from "./registry.ts";

const NOW = 1_786_000_000_000;
const SAVED_PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT;
const temps: string[] = [];

afterEach(() => {
  delete process.env.OMCA_DISABLED_HOOKS;
  delete process.env.OMCA_NATIVE_AGENTS_MD;
  if (SAVED_PLUGIN_ROOT === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
  else process.env.CLAUDE_PLUGIN_ROOT = SAVED_PLUGIN_ROOT;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "omca-context-"));
  temps.push(dir);
  return dir;
}

function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

// A project with a `.git` root and a plugin root whose shipped rules directory starts empty, so
// every expected context is exactly what the test wrote.
function project(): { root: string; shipped: string; rule: (name: string, text: string) => string } {
  const root = temp();
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, ".omca", "rules"), { recursive: true });
  const plugin = temp();
  mkdirSync(join(plugin, "rules"));
  process.env.CLAUDE_PLUGIN_ROOT = plugin;
  return { root, shipped: join(plugin, "rules"), rule: (name, text) => write(join(root, ".omca", "rules", name), text) };
}

type Injector = (tool: string, filePath: string) => Promise<string | undefined>;

function session(root: string): Injector {
  const sessionId = crypto.randomUUID();
  return async (tool, filePath) => {
    const output = await dispatch({ event: "PostToolUse", session_id: sessionId, tool_name: tool, tool_input: { file_path: filePath } }, root, NOW);
    return output.hookSpecificOutput?.additionalContext as string | undefined;
  };
}

const at = (path: string, seconds: number) => utimesSync(path, seconds, seconds);

describe("AGENTS.md and README.md on Read", () => {
  test("AGENTS.md: injected when reading a file in a dir containing AGENTS.md", async () => {
    const { root } = project();
    write(join(root, "subdir", "AGENTS.md"), "# My Agents Guide\n");
    const file = write(join(root, "subdir", "file.txt"), "");
    expect(await session(root)("Read", file)).toBe(`[AGENTS.md from ${root}/subdir]: # My Agents Guide`);
  });

  test("AGENTS.md: injection label includes directory path", async () => {
    const { root } = project();
    write(join(root, "subdir", "AGENTS.md"), "agent content here\n");
    const file = write(join(root, "subdir", "file.txt"), "");
    expect(await session(root)("Read", file)).toStartWith(`[AGENTS.md from ${root}/subdir]: `);
  });

  test("AGENTS.md and README.md from every directory up to the project root inject nearest first", async () => {
    const { root } = project();
    write(join(root, "README.md"), "# Root README\n");
    write(join(root, "a", "AGENTS.md"), "# A Agents\n");
    write(join(root, "a", "README.md"), "# A README\n");
    const file = write(join(root, "a", "b", "file.txt"), "");
    expect(await session(root)("Read", file)).toBe(
      [`[AGENTS.md from ${root}/a]: # A Agents`, `[README.md from ${root}/a]: # A README`, `[README.md from ${root}]: # Root README`].join("\n"),
    );
  });

  test("OMCA_NATIVE_AGENTS_MD=1: AGENTS.md excerpt skipped when no project CLAUDE.md exists", async () => {
    const { root } = project();
    write(join(root, "subdir", "AGENTS.md"), "# Natively Loaded Agents\n");
    const file = write(join(root, "subdir", "file.txt"), "");
    process.env.OMCA_NATIVE_AGENTS_MD = "1";
    expect(await session(root)("Read", file)).toBeUndefined();
  });

  test("OMCA_NATIVE_AGENTS_MD=1: AGENTS.md excerpt still injected when a project CLAUDE.md exists", async () => {
    const { root } = project();
    write(join(root, "CLAUDE.md"), "# Project memory\n");
    write(join(root, "subdir", "AGENTS.md"), "# Gated Agents Guide\n");
    const file = write(join(root, "subdir", "file.txt"), "");
    process.env.OMCA_NATIVE_AGENTS_MD = "1";
    expect(await session(root)("Read", file)).toBe(`[AGENTS.md from ${root}/subdir]: # Gated Agents Guide`);
  });

  test("OMCA_NATIVE_AGENTS_MD=1: a .claude/CLAUDE.md or CLAUDE.local.md also keeps the excerpt", async () => {
    for (const memory of [join(".claude", "CLAUDE.md"), "CLAUDE.local.md"]) {
      const { root } = project();
      write(join(root, memory), "# Project memory\n");
      write(join(root, "subdir", "AGENTS.md"), "# Gated Agents Guide\n");
      const file = write(join(root, "subdir", "file.txt"), "");
      process.env.OMCA_NATIVE_AGENTS_MD = "1";
      expect(await session(root)("Read", file)).toBe(`[AGENTS.md from ${root}/subdir]: # Gated Agents Guide`);
    }
  });

  test("native-loading skip is off by default: AGENTS.md excerpt injected with the gate unset", async () => {
    const { root } = project();
    write(join(root, "subdir", "AGENTS.md"), "# Default Path Agents\n");
    const file = write(join(root, "subdir", "file.txt"), "");
    expect(await session(root)("Read", file)).toBe(`[AGENTS.md from ${root}/subdir]: # Default Path Agents`);
  });

  test("OMCA_NATIVE_AGENTS_MD=1: README.md excerpt is unaffected by the AGENTS.md skip", async () => {
    const { root } = project();
    write(join(root, "subdir", "AGENTS.md"), "# Skipped Agents\n");
    write(join(root, "subdir", "README.md"), "# Kept README\n");
    const file = write(join(root, "subdir", "file.txt"), "");
    process.env.OMCA_NATIVE_AGENTS_MD = "1";
    expect(await session(root)("Read", file)).toBe(`[README.md from ${root}/subdir]: # Kept README`);
  });

  test("README.md: injected when reading a file in a dir containing README.md", async () => {
    const { root } = project();
    write(join(root, "subdir", "README.md"), "# Project README\n");
    const file = write(join(root, "subdir", "file.txt"), "");
    expect(await session(root)("Read", file)).toBe(`[README.md from ${root}/subdir]: # Project README`);
  });

  test("README.md: injection label includes directory path", async () => {
    const { root } = project();
    write(join(root, "subdir", "README.md"), "readme content\n");
    const file = write(join(root, "subdir", "file.txt"), "");
    expect(await session(root)("Read", file)).toStartWith(`[README.md from ${root}/subdir]: `);
  });

  test("AGENTS.md: NOT injected for Write events (Read-only directory traversal)", async () => {
    const { root } = project();
    write(join(root, "subdir", "AGENTS.md"), "# Secret Agent Docs\n");
    const file = write(join(root, "subdir", "file.txt"), "");
    const inject = session(root);
    expect(await inject("Write", file)).toBeUndefined();
    expect(await inject("Read", file)).toBe(`[AGENTS.md from ${root}/subdir]: # Secret Agent Docs`);
  });

  test("README.md: NOT injected for Write events", async () => {
    const { root } = project();
    write(join(root, "subdir", "README.md"), "# Secret README\n");
    const file = write(join(root, "subdir", "file.txt"), "");
    expect([await session(root)("Write", file), await session(root)("Edit", file)]).toEqual([undefined, undefined]);
  });

  test("AGENTS.md truncation: long AGENTS.md carries a note naming the full file path", async () => {
    const { root } = project();
    const agents = write(join(root, "subdir", "AGENTS.md"), "x".repeat(2500));
    const file = write(join(root, "subdir", "file.txt"), "");
    expect(await session(root)("Read", file)).toBe(`[AGENTS.md from ${root}/subdir]:  (truncated, read full file at ${agents})`);
  });
});

describe("directory dedup", () => {
  test("cache dedup: second Read for same directory skips AGENTS.md injection", async () => {
    const { root } = project();
    write(join(root, "subdir", "AGENTS.md"), "# Unique Agent Content\n");
    const file = write(join(root, "subdir", "file.txt"), "");
    const inject = session(root);
    expect(await inject("Read", file)).toBe(`[AGENTS.md from ${root}/subdir]: # Unique Agent Content`);
    expect(await inject("Read", file)).toBeUndefined();
  });

  test("mtime invalidation: editing AGENTS.md causes re-injection on next Read", async () => {
    const { root } = project();
    const agents = write(join(root, "subdir", "AGENTS.md"), "# Original content\n");
    at(agents, 1_700_000_000);
    const file = write(join(root, "subdir", "file.txt"), "");
    const inject = session(root);
    expect(await inject("Read", file)).toBe(`[AGENTS.md from ${root}/subdir]: # Original content`);
    write(agents, "# Updated content\n");
    at(agents, 1_700_000_001);
    expect(await inject("Read", file)).toBe(`[AGENTS.md from ${root}/subdir]: # Updated content`);
  });

  test("pipeline g: context-injector caches dir A, skips on second call, injects dir B", async () => {
    const { root } = project();
    const dirA = join(root, "src", "module-a");
    const dirB = join(root, "src", "module-b");
    write(join(dirA, "AGENTS.md"), "# AGENTS.md for module-a\nUse the standard patterns.\n");
    write(join(dirB, "AGENTS.md"), "# AGENTS.md for module-b\nUse the module-b patterns.\n");
    const fileA = write(join(dirA, "index.ts"), "export const foo = 1;\n");
    const fileB = write(join(dirB, "index.ts"), "export const bar = 2;\n");
    const inject = session(root);
    expect(await inject("Read", fileA)).toBe(`[AGENTS.md from ${dirA}]: # AGENTS.md for module-a\nUse the standard patterns.`);
    expect(await inject("Read", fileA)).toBeUndefined();
    expect(await inject("Read", fileB)).toBe(`[AGENTS.md from ${dirB}]: # AGENTS.md for module-b\nUse the module-b patterns.`);
  });

  test("a second session gets its own injection of an already-injected directory", async () => {
    const { root } = project();
    write(join(root, "subdir", "AGENTS.md"), "# Per Session\n");
    const file = write(join(root, "subdir", "file.txt"), "");
    const first = session(root);
    await first("Read", file);
    expect(await first("Read", file)).toBeUndefined();
    expect(await session(root)("Read", file)).toBe(`[AGENTS.md from ${root}/subdir]: # Per Session`);
  });
});

describe("rule matching", () => {
  test("rule matching: *.tsx rule injected when reading a .tsx file", async () => {
    const { root, rule } = project();
    rule("react.md", "# pattern: *.tsx\nUse functional components only.");
    const file = write(join(root, "Component.tsx"), "");
    expect(await session(root)("Read", file)).toBe("[Rule: *.tsx]: Use functional components only.");
  });

  test("rule matching: rule label includes the glob pattern", async () => {
    const { root, rule } = project();
    rule("react.md", "# pattern: *.tsx\nReact rule content.");
    const file = write(join(root, "Component.tsx"), "");
    expect(await session(root)("Read", file)).toStartWith("[Rule: *.tsx]: ");
  });

  test("rule matching: *.tsx rule injected on Write event too", async () => {
    const { root, rule } = project();
    rule("react.md", "# pattern: *.tsx\nAlways co-locate styles.");
    const file = write(join(root, "Component.tsx"), "");
    expect(await session(root)("Write", file)).toBe("[Rule: *.tsx]: Always co-locate styles.");
  });

  test("rule matching: a rule is injected on Edit as well", async () => {
    const { root, rule } = project();
    rule("react.md", "# pattern: *.tsx\nAlways co-locate styles.");
    const file = write(join(root, "Component.tsx"), "");
    expect(await session(root)("Edit", file)).toBe("[Rule: *.tsx]: Always co-locate styles.");
  });

  test("rule non-match: *.tsx rule NOT injected when reading a .sh file", async () => {
    const { root, rule } = project();
    rule("react.md", "# pattern: *.tsx\nReact-only content.");
    const file = write(join(root, "script.sh"), "");
    expect(await session(root)("Read", file)).toBeUndefined();
  });

  test("the pattern matches the basename whole: *.test.ts takes a.test.ts but not a.ts or a.test.tsx", async () => {
    const { root, rule } = project();
    rule("tests.md", "# pattern: *.test.ts\nAssert exact values.");
    const inject = session(root);
    const hits = [];
    for (const name of ["a.test.ts", "a.ts", "a.test.tsx", "test.ts"]) hits.push(await inject("Write", write(join(root, "src", name), "")));
    expect(hits).toEqual(["[Rule: *.test.ts]: Assert exact values.", undefined, undefined, undefined]);
  });

  test("the pattern never matches across a directory: a directory named like the pattern is not the basename", async () => {
    const { root, rule } = project();
    rule("py.md", "# pattern: *.py\nPython rule.");
    const inject = session(root);
    expect(await inject("Read", write(join(root, "pkg.py", "notes.txt"), ""))).toBeUndefined();
    expect(await inject("Read", write(join(root, "pkg.py", "mod.py"), ""))).toBe("[Rule: *.py]: Python rule.");
  });

  test("a file without a pattern header in the rules directory injects nothing", async () => {
    const { root, rule } = project();
    rule("README.md", "Runtime rule files loaded on path-matched Read/Write/Edit.\n");
    rule("notes.md", "# pattern: *.md\nWrap prose at 100 columns.");
    const file = write(join(root, "doc.md"), "");
    expect(await session(root)("Write", file)).toBe("[Rule: *.md]: Wrap prose at 100 columns.");
  });

  test("missing file: exits 0 with no output when file does not exist", async () => {
    const { root, rule } = project();
    rule("txt.md", "# pattern: *.txt\nText rule.");
    expect(await session(root)("Read", join(root, "nonexistent", "no-such-file.txt"))).toBeUndefined();
  });

  test("a relative or missing file_path injects nothing", async () => {
    const { root, rule } = project();
    rule("txt.md", "# pattern: *.txt\nText rule.");
    write(join(root, "file.txt"), "");
    const output = await dispatch({ event: "PostToolUse", session_id: crypto.randomUUID(), tool_name: "Read", tool_input: { path: "file.txt" } }, root, NOW);
    expect([output, await session(root)("Read", "file.txt")]).toEqual([{}, undefined]);
  });

  test("a tool other than Read, Write or Edit injects nothing", async () => {
    const { root, rule } = project();
    rule("txt.md", "# pattern: *.txt\nText rule.");
    write(join(root, "subdir", "AGENTS.md"), "# Agents\n");
    const file = write(join(root, "subdir", "file.txt"), "");
    expect([await session(root)("Bash", file), await session(root)("Agent", file)]).toEqual([undefined, undefined]);
  });

  test("multiple rules: two *.py rules both appear in output", async () => {
    const { root, rule } = project();
    rule("py-style.md", "# pattern: *.py\nPython rule one content.");
    rule("py-lint.md", "# pattern: *.py\nPython rule two content.");
    const file = write(join(root, "main.py"), "");
    expect(await session(root)("Read", file)).toBe("[Rule: *.py]: Python rule two content.\n[Rule: *.py]: Python rule one content.");
  });

  test("rule truncation: rule body longer than 1000 chars is truncated to 1000 chars", async () => {
    const { root, rule } = project();
    const path = rule("long-rule.md", `# pattern: *.py\n${"x".repeat(1200)}`);
    const file = write(join(root, "main.py"), "");
    expect(await session(root)("Read", file)).toBe(`[Rule: *.py]: ${"x".repeat(1000)} (truncated, read full rule at ${path})`);
  });

  test("rule truncation: truncated rule body carries a note naming the full file path", async () => {
    const { root, rule } = project();
    const path = rule("long-rule.md", `# pattern: *.py\n${"x".repeat(1200)}`);
    const file = write(join(root, "main.py"), "");
    expect(await session(root)("Read", file)).toEndWith(` (truncated, read full rule at ${path})`);
  });

  test("rule non-truncation: short rule body carries no truncation note", async () => {
    const { root, rule } = project();
    rule("short-rule.md", "# pattern: *.py\nShort rule body.");
    const file = write(join(root, "main.py"), "");
    expect(await session(root)("Read", file)).toBe("[Rule: *.py]: Short rule body.");
  });
});

describe("rule precedence", () => {
  test("a project rule shadows the shipped rule of the same name", async () => {
    const { root, shipped, rule } = project();
    write(join(shipped, "comments-python.md"), "# pattern: *.py\nShipped python rule.");
    write(join(shipped, "comments-go.md"), "# pattern: *.go\nShipped go rule.");
    rule("comments-python.md", "# pattern: *.py\nProject python rule.");
    const inject = session(root);
    expect(await inject("Read", write(join(root, "main.py"), ""))).toBe("[Rule: *.py]: Project python rule.");
    expect(await inject("Read", write(join(root, "main.go"), ""))).toBe("[Rule: *.go]: Shipped go rule.");
  });

  test("a project rule with an empty body switches the shipped rule of the same name off", async () => {
    const { root, shipped, rule } = project();
    write(join(shipped, "comments-python.md"), "# pattern: *.py\nShipped python rule.");
    rule("comments-python.md", "# pattern: *.py\n");
    expect(await session(root)("Read", write(join(root, "main.py"), ""))).toBeUndefined();
  });

  test("project rules come before shipped rules, each directory in name order", async () => {
    const { root, shipped, rule } = project();
    write(join(shipped, "a-shipped.md"), "# pattern: *.py\nShipped.");
    rule("b-project.md", "# pattern: *.py\nProject b.");
    rule("a-project.md", "# pattern: *.py\nProject a.");
    expect(await session(root)("Read", write(join(root, "main.py"), ""))).toBe(
      "[Rule: *.py]: Project a.\n[Rule: *.py]: Project b.\n[Rule: *.py]: Shipped.",
    );
  });

  test("the plugin's own rules directory is the shipped one when no plugin root is set", async () => {
    const { root } = project();
    delete process.env.CLAUDE_PLUGIN_ROOT;
    const shippedProse = join(import.meta.dir, "..", "..", "rules", "prose-md.md");
    const [header = "", ...body] = readFileSync(shippedProse, "utf8").replace(/\n+$/, "").split("\n");
    const text = body.join("\n");
    const note = text.length > 1000 ? ` (truncated, read full rule at ${shippedProse})` : "";
    expect(await session(root)("Write", write(join(root, "notes.md"), "hello"))).toBe(
      `[Rule: ${header.slice("# pattern: ".length)}]: ${text.slice(0, 1000)}${note}`,
    );
  });

  test("a rule added after the first injection is picked up once its directory changes", async () => {
    const { root, rule } = project();
    rule("first.md", "# pattern: *.py\nFirst rule.");
    const file = write(join(root, "main.py"), "");
    const inject = session(root);
    expect(await inject("Read", file)).toBe("[Rule: *.py]: First rule.");
    rule("second.md", "# pattern: *.py\nSecond rule.");
    at(join(root, ".omca", "rules"), 1_700_000_100);
    expect(await inject("Read", file)).toBe("[Rule: *.py]: Second rule.");
  });
});

describe("rule dedup", () => {
  test("rule dedup: second Read of the same file does NOT re-inject an already-injected rule", async () => {
    const { root, rule } = project();
    rule("dedup.md", "# pattern: *.py\nDedup rule content.");
    const file = write(join(root, "main.py"), "");
    const inject = session(root);
    expect(await inject("Read", file)).toBe("[Rule: *.py]: Dedup rule content.");
    expect(await inject("Read", file)).toBeUndefined();
  });

  test("rule dedup: a rule matching a different file on second call still injects (not globally suppressed)", async () => {
    const { root, rule } = project();
    rule("shared.md", "# pattern: *.py\nShared rule content.");
    const inject = session(root);
    expect(await inject("Read", write(join(root, "first.py"), ""))).toBe("[Rule: *.py]: Shared rule content.");
    expect(await inject("Read", write(join(root, "second.py"), ""))).toBeUndefined();
  });

  test("an unchanged rule injects once, an edited one re-injects", async () => {
    const { root, rule } = project();
    const path = rule("r.md", "# pattern: *.py\nRULE BODY v1\n");
    at(path, 1_700_000_000);
    const file = write(join(root, "f.py"), "x=1\n");
    const inject = session(root);
    expect(await inject("Read", file)).toBe("[Rule: *.py]: RULE BODY v1");
    expect(await inject("Read", file)).toBeUndefined();
    rule("r.md", "# pattern: *.py\nRULE BODY v2\n");
    at(path, 1_700_000_001);
    expect(await inject("Read", file)).toBe("[Rule: *.py]: RULE BODY v2");
  });

  test("two rule paths with the same body both inject, a symlink included, since the key is the path as given", async () => {
    const { root, rule } = project();
    const real = rule("real-rule.md", "# pattern: *.py\nSymlink rule content.");
    symlinkSync(real, join(root, ".omca", "rules", "alias-rule.md"));
    const file = write(join(root, "main.py"), "");
    const inject = session(root);
    expect(await inject("Read", file)).toBe("[Rule: *.py]: Symlink rule content.\n[Rule: *.py]: Symlink rule content.");
    expect(await inject("Read", file)).toBeUndefined();
  });
});

describe("context budget", () => {
  // Twelve rules with 1,000-character bodies sorted ahead of zz-last.md, which carries a sentinel.
  function budgetRules(rule: (name: string, text: string) => string): string[] {
    const body = "y".repeat(1000);
    const paths = Array.from({ length: 12 }, (_, i) => rule(`a-${String(i + 1).padStart(2, "0")}.md`, `# pattern: *.py\n${body}`));
    return [...paths, rule("zz-last.md", `# pattern: *.py\nLAST_RULE_SENTINEL ${body}`)];
  }

  test("context budget: total injected context stays within 8000 chars and names dropped paths", async () => {
    const { root, rule } = project();
    const paths = budgetRules(rule);
    const context = await session(root)("Read", write(join(root, "main.py"), ""));
    const kept = Array.from({ length: 7 }, () => `[Rule: *.py]: ${"y".repeat(1000)}`);
    const marker = `[context budget reached, 6 item(s) deferred to a later event: ${paths.slice(7).join(" ")}]`;
    expect(context).toBe([...kept, marker].join("\n"));
    expect(context?.length).toBeLessThanOrEqual(8000);
  });

  test("context budget: a rule dropped for budget is not cached and injects on the next event", async () => {
    const { root, rule } = project();
    const last = budgetRules(rule).at(-1);
    const file = write(join(root, "main.py"), "");
    const inject = session(root);
    expect(await inject("Read", file)).not.toContain("LAST_RULE_SENTINEL");
    const second = await inject("Read", file);
    expect(second?.split("\n")).toEqual([
      ...Array.from({ length: 5 }, () => `[Rule: *.py]: ${"y".repeat(1000)}`),
      `[Rule: *.py]: ${`LAST_RULE_SENTINEL ${"y".repeat(1000)}`.slice(0, 1000)} (truncated, read full rule at ${last})`,
    ]);
    expect(await inject("Read", file)).toBeUndefined();
  });

  test("a directory whose README.md is deferred keeps neither excerpt marked, so both inject later", async () => {
    const { root, rule } = project();
    rule("big.md", `# pattern: *.txt\n${"y".repeat(1000)}`);
    write(join(root, "d", "AGENTS.md"), `${"a".repeat(1990)}\n`);
    write(join(root, "d", "README.md"), `${"r".repeat(1990)}\n`);
    const deep = join(root, "d", "e", "d2", "d3");
    write(join(root, "d", "e", "d2", "AGENTS.md"), `${"b".repeat(1990)}\n`);
    write(join(deep, "AGENTS.md"), `${"b".repeat(1990)}\n`);
    const file = write(join(deep, "f.txt"), "");
    const labels = (context: string | undefined) => context?.split("\n").map((line) => line.slice(0, line.indexOf("]") + 1));
    const inject = session(root);
    expect(labels(await inject("Read", file))).toEqual([
      `[AGENTS.md from ${deep}]`,
      `[AGENTS.md from ${root}/d/e/d2]`,
      `[AGENTS.md from ${root}/d]`,
      "[Rule: *.txt]",
      `[context budget reached, 1 item(s) deferred to a later event: ${root}/d/README.md]`,
    ]);
    expect(labels(await inject("Read", file))).toEqual([`[AGENTS.md from ${root}/d]`, `[README.md from ${root}/d]`]);
    expect(await inject("Read", file)).toBeUndefined();
  });
});

describe("worktree-safe project root", () => {
  test("worktree root: AGENTS.md walk terminates at the linked worktree's .git file, not the parent dir", async () => {
    const { root } = project();
    const parent = temp();
    const worktree = join(parent, "worktree");
    write(join(worktree, ".git"), "gitdir: /some/main/repo/.git/worktrees/wt\n");
    write(join(worktree, "AGENTS.md"), "# Worktree Agents\n");
    write(join(parent, "AGENTS.md"), "# Parent Secret Agents\n");
    const file = write(join(worktree, "subdir", "file.txt"), "");
    expect(await session(root)("Read", file)).toBe(`[AGENTS.md from ${worktree}]: # Worktree Agents`);
  });

  test("worktree root: .omca/rules scan uses the worktree root, not CLAUDE_PROJECT_ROOT", async () => {
    const { root, rule } = project();
    const worktree = temp();
    write(join(worktree, ".git"), "gitdir: /some/main/repo/.git/worktrees/wt2\n");
    write(join(worktree, ".omca", "rules", "local.md"), "# pattern: *.py\nWorktree-local rule content.");
    rule("main.md", "# pattern: *.py\nMain repo rule content.");
    expect(await session(root)("Read", write(join(worktree, "main.py"), ""))).toBe("[Rule: *.py]: Worktree-local rule content.");
  });
});

describe("kill switch and golden fixtures", () => {
  test("OMCA_DISABLED_HOOKS=context-injector injects nothing, and another hook's name leaves it on", async () => {
    const { root, rule } = project();
    rule("react.md", "# pattern: *.tsx\nUse functional components only.");
    const file = write(join(root, "Component.tsx"), "");
    process.env.OMCA_DISABLED_HOOKS = "context-injector";
    expect(await session(root)("Read", file)).toBeUndefined();
    process.env.OMCA_DISABLED_HOOKS = "plan-format-warn";
    expect(await session(root)("Read", file)).toBe("[Rule: *.tsx]: Use functional components only.");
  });

  for (const tool of ["Read", "Write", "Edit"]) {
    test(`${tool.toLowerCase()}-no-agents replays to an empty answer`, async () => {
      const { root } = project();
      const fixture = { hook_event_name: "PostToolUse", tool_name: tool, tool_input: { file_path: "/tmp/testfile.txt" }, session_id: "fixture-sid-001" };
      expect(await dispatch({ ...fixture, event: fixture.hook_event_name }, root, NOW)).toEqual({});
    });
  }
});
