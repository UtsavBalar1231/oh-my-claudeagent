import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { hasCode, projectRoot } from "../io.ts";
import type { Tool } from "../omca.ts";
import { IDLE_CONTEXT, type Progress } from "../progress.ts";
import { argReader } from "./args.ts";

const LANGUAGES = [
  "bash",
  "c",
  "cpp",
  "csharp",
  "css",
  "elixir",
  "go",
  "haskell",
  "html",
  "java",
  "javascript",
  "json",
  "kotlin",
  "lua",
  "nix",
  "php",
  "python",
  "ruby",
  "rust",
  "scala",
  "solidity",
  "swift",
  "typescript",
  "tsx",
  "yaml",
] as const;
type Language = (typeof LANGUAGES)[number];

// The extensions ast-grep 0.44.1 scans for each language, measured by running it on one file of each.
const LANG_EXTENSIONS: Record<string, Language> = {
  ".bash": "bash",
  ".bats": "bash",
  ".cgi": "bash",
  ".command": "bash",
  ".fcgi": "bash",
  ".ksh": "bash",
  ".sh": "bash",
  ".tmux": "bash",
  ".tool": "bash",
  ".zsh": "bash",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".c++": "cpp",
  ".cc": "cpp",
  ".cu": "cpp",
  ".cxx": "cpp",
  ".hh": "cpp",
  ".hpp": "cpp",
  ".ino": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".scss": "css",
  ".ex": "elixir",
  ".exs": "elixir",
  ".go": "go",
  ".hs": "haskell",
  ".html": "html",
  ".htm": "html",
  ".xhtml": "html",
  ".java": "java",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".kt": "kotlin",
  ".ktm": "kotlin",
  ".kts": "kotlin",
  ".lua": "lua",
  ".nix": "nix",
  ".php": "php",
  ".bzl": "python",
  ".py": "python",
  ".py3": "python",
  ".pyi": "python",
  ".gemspec": "ruby",
  ".rb": "ruby",
  ".rbw": "ruby",
  ".rs": "rust",
  ".sbt": "scala",
  ".sc": "scala",
  ".scala": "scala",
  ".sol": "solidity",
  ".swift": "swift",
  ".ts": "typescript",
  ".cts": "typescript",
  ".mts": "typescript",
  ".tsx": "tsx",
  ".yml": "yaml",
  ".yaml": "yaml",
};

const TIMEOUT_MS = 300_000;
const HEARTBEAT_MS = 1_000;
const MAX_RESULTS_DEFAULT = 500;
const MAX_RESULT_CAP = 500;
const MAX_JSON_OUTPUT_BYTES = 1024 * 1024;
// A full MAX_RESULT_CAP of matches with code snippets passes the client's default persist-to-disk
// threshold; this keeps them inline and stays under the client's 500000 ceiling.
const SEARCH_MAX_RESULT_CHARS = 200_000;
const OUTPUT_CAPPED = "[TRUNCATED] Output exceeded AST MCP caps\n\n";

const INSTALL_OPTIONS = [
  "  cargo install ast-grep --locked",
  "  brew install ast-grep",
  "  npm install -g @ast-grep/cli",
  "  pacman -S ast-grep",
  "  pip install ast-grep-cli",
  "  scoop install main/ast-grep",
];

const INSTALL_HINT = [
  "ast-grep binary not found (looked for $AST_GREP_BIN, ast-grep and sg on PATH).",
  "",
  "Install options:",
  ...INSTALL_OPTIONS,
].join("\n");

const WINDOWS_SHIM = /\.(cmd|bat|ps1)$/i;

type Match = {
  file?: string;
  lines?: string;
  text?: string;
  replacement?: string;
  ruleId?: string;
  severity?: string;
  range?: { start?: { line?: number; column?: number } };
};

/**
 * On Windows a `.cmd`, `.bat` or `.ps1` shim is replaced by the native binary the npm package
 * keeps beside it. A shim cannot carry the multi-line `--inline-rules` YAML, and cmd.exe parses
 * the shell metacharacters in a pattern, so with no native binary the call is refused.
 */
export function resolveNative(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32" || !WINDOWS_SHIM.test(path)) return path;
  const name = basename(path).replace(WINDOWS_SHIM, "") === "sg" ? "sg.exe" : "ast-grep.exe";
  const native = join(dirname(path), "node_modules", "@ast-grep", "cli", name);
  if (existsSync(native)) return native;
  throw new Error(
    [
      `ast-grep resolved to ${path}, a batch shim that cannot pass multi-line rules or shell metacharacters intact, and no ${name} sits beside it.`,
      "",
      "Install a native binary:",
      ...INSTALL_OPTIONS,
    ].join("\n"),
  );
}

let discovered: { key: string; binary: string } | undefined;

/** The binary for the current $AST_GREP_BIN and PATH, found once per pair of values. A failed search is not remembered. */
export function discoverBinary(): string {
  const key = `${process.env.AST_GREP_BIN ?? ""}\0${process.env.PATH ?? ""}`;
  if (discovered?.key !== key) discovered = { key, binary: findBinary() };
  return discovered.binary;
}

function findBinary(): string {
  const path = process.env.PATH ?? "";
  const configured = process.env.AST_GREP_BIN;
  if (configured) {
    const resolved = Bun.which(configured, { PATH: path });
    if (resolved !== null) return WINDOWS_SHIM.test(resolved) ? resolveNative(resolved) : configured;
    console.error(`omca: $AST_GREP_BIN=${configured} not found in PATH`);
  }
  let refusal: Error | undefined;
  for (const name of ["ast-grep", "sg"]) {
    const which = Bun.which(name, { PATH: path });
    if (which === null) continue;
    let found: string;
    try {
      found = resolveNative(which);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      refusal ??= error;
      continue;
    }
    // `sg` is also the shadow-utils newgrp alias, so a hit is accepted only if it identifies itself.
    const version = Bun.spawnSync([found, "--version"], {
      stdin: "ignore",
      stderr: "ignore",
      timeout: 5_000,
      windowsHide: true,
    });
    if (version.stdout.toString().toLowerCase().includes("ast-grep")) return found;
  }
  throw refusal ?? new Error(INSTALL_HINT);
}

export async function run(
  argv: string[],
  options: { input?: string; allowExit1?: boolean; timeoutMs?: number; signal?: AbortSignal; progress?: Progress } = {},
) {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const { signal, progress } = options;
  signal?.throwIfAborted();
  const started = performance.now();
  const proc = Bun.spawn([discoverBinary(), ...argv], {
    cwd: workspace(),
    stdin: options.input === undefined ? "ignore" : Buffer.from(options.input),
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    windowsHide: true,
    ...(signal && { signal }),
  });
  progress?.({ message: "ast-grep running" });
  const heartbeat =
    progress &&
    setInterval(
      () => progress({ message: `ast-grep running, ${Math.round((performance.now() - started) / 1000)}s` }),
      HEARTBEAT_MS,
    );
  let stdout: Uint8Array, stderrBytes: Uint8Array, exitCode: number;
  try {
    [stdout, stderrBytes, exitCode] = await Promise.all([
      new Response(proc.stdout).bytes(),
      new Response(proc.stderr).bytes(),
      proc.exited,
    ]);
  } finally {
    clearInterval(heartbeat);
  }
  signal?.throwIfAborted();
  // Windows ends a timed-out process without setting signalCode, so the clock is the evidence.
  if (performance.now() - started >= timeoutMs) throw new Error(`Command timed out after ${timeoutMs / 1000}s`);
  const stderr = new TextDecoder().decode(stderrBytes);
  // `run` exits 1 on no match; a `scan` rule of severity error exits 1 on a match.
  if (exitCode !== 0 && !(options.allowExit1 && exitCode === 1)) {
    const detail = stderr.trim();
    if (detail === "") throw new Error(`ast-grep exited ${exitCode} with no message`);
    if (!detail.includes("No files found")) throw new Error(`ast-grep error (exit ${exitCode}): ${detail}`);
  }
  return { stdout, stderr };
}

function workspace(): string {
  const configured = process.env.CLAUDE_PROJECT_DIR || process.env.CLAUDE_PROJECT_ROOT;
  return realpathSync.native(projectRoot(configured || process.cwd()));
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path.split(sep)[0] !== "..");
}

export function gitWorktreeRoots(dir: string): string[] {
  try {
    const git = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], {
      cwd: dir,
      stderr: "ignore",
      timeout: 5_000,
      windowsHide: true,
    });
    if (git.exitCode !== 0) return [];
    return git.stdout
      .toString()
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length))
      .filter((root) => existsSync(root))
      .map((root) => realpathSync.native(root));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
}

// A path in the workspace comes back workspace-relative, matching the cwd every invocation runs
// under. A path in a sibling worktree of the same repository is in scope too and has no useful
// relative spelling, so it stays absolute. The worktree list costs a git call and is read only
// once a path has failed the workspace check. An existing path is judged by its canonical
// spelling, which folds case and short names where the filesystem does; one that does not exist
// yet can only be judged as written.
function normalizePaths(paths: string[] | undefined): string[] {
  const root = workspace();
  let worktrees: string[] | undefined;
  const owner = (candidate: string): string | undefined => {
    if (within(root, candidate)) return root;
    worktrees ??= gitWorktreeRoots(root);
    return worktrees.find((worktree) => within(worktree, candidate));
  };
  return (paths?.length ? paths : ["."]).map((path) => {
    if (path === "") throw new Error("Path entries must not be empty");
    if (path.includes("\0")) throw new Error("Path entries must not contain null bytes");
    if (path.startsWith("-")) throw new Error("Path entries must not start with '-'");
    const absolute = resolve(root, path);
    const canonical = existsSync(absolute) ? realpathSync.native(absolute) : absolute;
    const home = owner(canonical);
    if (home === undefined) {
      throw new Error(owner(absolute) === undefined ? `Path escapes workspace: ${path}` : `Path resolves outside workspace: ${path}`);
    }
    const spelled = within(home, absolute) ? absolute : canonical;
    return home === root ? relative(root, spelled) || "." : spelled;
  });
}

function parseMatches(stdout: Uint8Array): { matches: Match[]; truncated: boolean } {
  const capped = stdout.length > MAX_JSON_OUTPUT_BYTES;
  const text = new TextDecoder().decode(stdout.subarray(0, MAX_JSON_OUTPUT_BYTES)).trim();
  if (text === "") return { matches: [], truncated: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (!capped) throw new Error(`Failed to parse ast-grep JSON output: ${error instanceof Error ? error.message : error}`);
    parsed = leadingObjects(text);
    if (parsed === undefined) {
      throw new Error("ast-grep JSON output exceeded 1 MiB and could not be parsed through a complete result");
    }
  }
  if (!Array.isArray(parsed)) throw new Error("Failed to parse ast-grep JSON output: expected a JSON array");
  return { matches: parsed.slice(0, MAX_RESULT_CAP), truncated: capped || parsed.length > MAX_RESULT_CAP };
}

function leadingObjects(text: string): unknown[] | undefined {
  const items: unknown[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  let escaped = false;
  for (let i = 1; i < text.length && items.length < MAX_RESULT_CAP; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      if (depth++ === 0) start = i;
    } else if (char === "}" || char === "]") {
      if (--depth === 0) items.push(JSON.parse(text.slice(start, i + 1)));
    }
  }
  return items.length > 0 ? items : undefined;
}

function noMatchMessage(pattern: string, lang: string, isReplace: boolean): string {
  const base = isReplace ? "No matches found to replace" : "No matches found";
  const stripped = pattern.trim();
  const hints: string[] = [];
  if (/\\[wWdDsSbB]/.test(stripped)) {
    hints.push(
      "Regex escapes like \\w, \\d, \\s, and \\b do not work in ast-grep patterns. Use $VAR for one AST node or switch to grep for text search.",
    );
  }
  if (/\[[A-Za-z0-9]-[A-Za-z0-9]\]/.test(stripped)) {
    hints.push("Character ranges like [a-z] are regex syntax, not AST syntax. Use $VAR for identifiers or switch to grep.");
  }
  if (!stripped.includes("$") && /\.[*+]/.test(stripped)) {
    hints.push("Regex wildcards like .* and .+ do not work in ast-grep. Use $$$ for multiple AST nodes or switch to grep.");
  }
  if (/^[-\w.*]+\|[-\w.*|]+$/.test(stripped)) {
    hints.push("Regex alternation with | does not work in ast-grep patterns. Run separate AST searches or switch to grep.");
  }
  if (lang === "c" && /^[A-Za-z_]\w*\s*\(.*\)$/.test(stripped)) {
    hints.push(
      "In C a bare call pattern like `name($$$)` parses as a type/macro " +
        "(macro_type_specifier), not a function call, so it never matches real call " +
        "sites and silently returns nothing. Use ast_find_rule with `kind: " +
        "call_expression` (match the name via `has: {field: function, regex: '^name$'}`), " +
        "or a pattern object giving expression context: `context: 'int v = name($$$);'` " +
        "with `selector: call_expression`.",
    );
  }
  if (lang === "python" && /^(def |class |async def )/.test(stripped) && stripped.endsWith(":")) {
    hints.push(`Remove the trailing colon. Try \`${stripped.slice(0, -1)}\`.`);
  }
  if (["javascript", "typescript", "tsx"].includes(lang) && pattern.includes("function") && !pattern.includes("{")) {
    hints.push("JS/TS/TSX function patterns should be complete AST nodes, e.g. `function $NAME($$$ARGS) { $$$BODY }`.");
  }
  if (lang === "go" && pattern.trimStart().startsWith("func") && !pattern.includes("{")) {
    hints.push("Go function patterns should include a body, e.g. `func $NAME($$$ARGS) { $$$BODY }`.");
  }
  if (lang === "rust" && pattern.trimStart().startsWith("fn ") && !pattern.includes("{")) {
    hints.push("Rust function patterns should include a body, e.g. `fn $NAME($$$ARGS) { $$$BODY }`.");
  }
  return hints.length === 0 ? base : `${base}\n\nHints:\n- ${hints.join("\n- ")}`;
}

// `ast-grep run` reports an ERROR-node pattern as a stderr warning while still exiting 0 or 1;
// only that line is kept and the Help and URL lines that follow it are dropped.
export function patternWarning(stderr: string): string | undefined {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("Warning:") && line.includes("ERROR node"));
}

// ast-grep filters files by the language's extension set even with an explicit `--lang`, so
// `cpp` against a `.c` file scans nothing and returns a silent zero. A directory leaves the
// contents unknown, so it never warns.
export function extensionMismatch(paths: string[], lang: string): string | undefined {
  const extensions = Object.entries(LANG_EXTENSIONS)
    .filter(([, mapped]) => mapped === lang)
    .map(([extension]) => extension);
  if (extensions.length === 0) return undefined;
  const root = workspace();
  const files: string[] = [];
  for (const path of paths) {
    const stat = statSync(resolve(root, path), { throwIfNoEntry: false });
    if (stat?.isDirectory()) return undefined;
    if (stat?.isFile()) files.push(path);
  }
  if (files.length === 0 || files.some((file) => extensions.includes(extname(file)))) return undefined;
  return (
    `None of the given file path(s) have an extension mapped to lang='${lang}'. ` +
    "ast-grep filters files by language extension, so it likely scanned nothing. " +
    "Check that lang matches the files' type."
  );
}

function zeroMatchMessage(pattern: string, lang: string, stderr: string, paths: string[], isReplace = false): string {
  const extras: string[] = [];
  const warning = patternWarning(stderr);
  if (warning !== undefined) {
    extras.push(
      `${warning} Replace literal sub-parts with metavariables ($VAR / $$$), or use ast_find_rule with an explicit \`kind:\`.`,
    );
  }
  const mismatch = extensionMismatch(paths, lang);
  if (mismatch !== undefined) extras.push(mismatch);
  const message = noMatchMessage(pattern, lang, isReplace);
  return extras.length === 0 ? message : `${message}\n\n${extras.join("\n")}`;
}

const position = (m: Match) => `${(m.range?.start?.line ?? 0) + 1}:${(m.range?.start?.column ?? 0) + 1}`;
const snippet = (m: Match) => (m.lines ?? m.text ?? "").trim();
const withCapNotice = (output: string, truncated: boolean) =>
  truncated && !output.startsWith("[TRUNCATED]") ? OUTPUT_CAPPED + output : output;
const jsonMatches = (matches: Match[], maxResults: number, truncated: boolean) =>
  JSON.stringify({ truncated: truncated || matches.length > maxResults, matches: matches.slice(0, maxResults) }, null, 2);
const globArgs = (globs: string[]) => globs.map((glob) => `--globs=${glob}`);

function formatRun(matches: Match[], maxResults: number, replace?: { dryRun: boolean }): string {
  const shown = matches.slice(0, maxResults);
  if (shown.length === 0) return replace ? "No matches found to replace" : "No matches found";
  const lines: string[] = [];
  if (matches.length > maxResults) lines.push(`[TRUNCATED] Showing first ${maxResults} of ${matches.length} matches\n`);
  if (replace) lines.push(`${replace.dryRun ? "[DRY RUN] " : ""}${shown.length} replacement(s):\n`);
  else lines.push(`Found ${shown.length} match(es):\n`);
  for (const match of shown) {
    lines.push(`${match.file ?? ""}:${position(match)}`);
    if (snippet(match) !== "") lines.push(`  ${snippet(match)}`);
    if (replace && typeof match.replacement === "string") lines.push(`  -> ${match.replacement.trim()}`);
    lines.push("");
  }
  if (replace?.dryRun) lines.push("Use dry_run=false to apply changes");
  return lines.join("\n");
}

function formatScan(matches: Match[], maxResults: number): string {
  const shown = matches.slice(0, maxResults);
  if (shown.length === 0) return "No matches found";
  const lines: string[] = [];
  if (matches.length > maxResults) lines.push(`[TRUNCATED] Showing first ${maxResults} of ${matches.length} matches\n`);
  lines.push(`Found ${shown.length} match(es):\n`);
  for (const match of shown) {
    let header = `${match.file ?? ""}:${position(match)}`;
    if (match.ruleId) header += ` [${match.ruleId}]`;
    if (match.severity) header += ` (${match.severity})`;
    lines.push(header);
    if (snippet(match) !== "") lines.push(`  ${snippet(match)}`);
    lines.push("");
  }
  return lines.join("\n");
}

const clampResults = (maxResults: number) => Math.max(0, Math.min(maxResults, MAX_RESULT_CAP));

const pathsProperty = { type: "array", items: { type: "string" }, description: "Paths to search (default: ['.'])" };
const maxResultsProperty = { type: "integer", default: MAX_RESULTS_DEFAULT, description: "Maximum matches to return" };
const outputFormatProperty = {
  type: "string",
  enum: ["text", "json"],
  default: "text",
  description: "Output format: text (compact) or json ({truncated, matches} with full match objects; truncated is true when more matches exist than returned)",
};
const languageEnum = { type: "string", enum: LANGUAGES };
const NO_RULE_MATCH =
  "No matches found.\n\n" +
  "Hint: If using relational rules (has, inside, follows, precedes), " +
  "try adding `stopBy: end` to search the entire subtree.";

export const tools: Tool[] = [
  {
    name: "ast_search",
    description:
      "Search code by syntax pattern with ast-grep. Use it instead of text search when the target is structural (function signatures, class shapes, import forms, call patterns); use rg for plain text, comments, or string contents. Paths must lie inside the project root or one of its git worktrees; any other path is rejected with an error, so search outside the repository with rg. Only files whose extension maps to lang are scanned (lang='cpp' skips .c files). Returns file:line:col and the matched line for each hit, at most 500 hits (max_results can lower that), with a [TRUNCATED] marker when more exist; a zero-match result carries hints when the pattern uses regex syntax that ast-grep does not support.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "AST pattern with meta-variables ($VAR for single node, $$$ for multiple). Must be a complete AST node.",
        },
        lang: { ...languageEnum, description: "Target language" },
        paths: pathsProperty,
        globs: {
          type: "array",
          items: { type: "string" },
          description: "Include/exclude globs (prefix ! to exclude)",
        },
        context: { type: "integer", description: "Context lines around each match" },
        max_results: maxResultsProperty,
        output_format: outputFormatProperty,
      },
      required: ["pattern", "lang"],
    },
    annotations: { title: "Search code by AST pattern", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    _meta: {
      "anthropic/searchHint":
        "structural code search by syntax pattern in the languages listed under lang; use instead of grep when the pattern is syntactic",
      "anthropic/maxResultSizeChars": SEARCH_MAX_RESULT_CHARS,
    },
    call: async (args, ctx = IDLE_CONTEXT) => {
      const a = argReader(args, "ast_search");
      const pattern = a.string("pattern");
      const lang = a.choice("lang", LANGUAGES);
      const paths = normalizePaths(a.strings("paths"));
      const globs = a.strings("globs") ?? [];
      const context = a.integer("context", 0);
      const maxResults = clampResults(a.integer("max_results", MAX_RESULTS_DEFAULT));
      const format = a.choice("output_format", ["text", "json"], "text");
      const result = await run(
        [
          "run",
          `--pattern=${pattern}`,
          "--lang",
          lang,
          "--json=compact",
          ...(context > 0 ? ["-C", String(context)] : []),
          ...globArgs(globs),
          "--",
          ...paths,
        ],
        { allowExit1: true, ...ctx },
      );
      const { matches, truncated } = parseMatches(result.stdout);
      if (matches.length === 0) return zeroMatchMessage(pattern, lang, result.stderr, paths);
      if (format === "json") return jsonMatches(matches, maxResults, truncated);
      return withCapNotice(formatRun(matches, maxResults), truncated);
    },
  },
  {
    name: "ast_replace",
    description:
      "Rewrite code by syntax pattern with ast-grep, for structural refactors such as renaming a call, reordering arguments, or migrating an API. Paths must lie inside the project root or one of its git worktrees; any other path is rejected. Preview first: dry_run defaults to true and writes nothing; pass dry_run=false only once the preview shows the intended change set. The write goes to disk through ast-grep rather than the Edit tool, so Edit hooks and read-before-edit checks do not run. Returns list of replacements with file:line locations. Apply is refused when matches exceed the 500-match preview cap; narrow paths, globs, or the pattern until the full change set previews.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "AST pattern to match" },
        rewrite: {
          type: "string",
          description: "Replacement pattern (can use $VAR from the match pattern)",
        },
        lang: { ...languageEnum, description: "Target language" },
        paths: { type: "array", items: { type: "string" }, description: "Paths to search" },
        globs: { type: "array", items: { type: "string" }, description: "Include/exclude globs" },
        dry_run: {
          type: "boolean",
          default: true,
          description: "Preview changes without applying (default: true)",
        },
      },
      required: ["pattern", "rewrite", "lang"],
    },
    annotations: {
      title: "Rewrite code by AST pattern",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    _meta: { "anthropic/searchHint": "AST-aware structural find-and-replace refactor across files" },
    call: async (args, ctx = IDLE_CONTEXT) => {
      const a = argReader(args, "ast_replace");
      const pattern = a.string("pattern");
      const rewrite = a.string("rewrite");
      const lang = a.choice("lang", LANGUAGES);
      const paths = normalizePaths(a.strings("paths"));
      const globs = a.strings("globs") ?? [];
      const dryRun = a.boolean("dry_run", true);
      const rule = [`--pattern=${pattern}`, `--rewrite=${rewrite}`, "--lang", lang];
      const scope = [...globArgs(globs), "--", ...paths];
      const preview = await run(["run", ...rule, "--json=compact", ...scope], { allowExit1: true, ...ctx });
      const { matches, truncated } = parseMatches(preview.stdout);
      if (matches.length === 0) return zeroMatchMessage(pattern, lang, preview.stderr, paths, true);
      if (!dryRun) {
        // --update-all rewrites every match on disk while the preview stops at the cap, so a
        // capped preview must never be applied.
        if (truncated) {
          throw new Error(
            `Refusing to apply: matches exceed the ${MAX_RESULT_CAP}-result preview cap, so --update-all would rewrite files the dry run did not show. Narrow the scope with paths/globs or a more specific pattern until the full change set previews, then re-run with dry_run=false.`,
          );
        }
        try {
          await run(["run", ...rule, "--update-all", ...scope], ctx);
        } catch (error) {
          throw new Error(`Replace failed: ${error instanceof Error ? error.message : error}`);
        }
      }
      return withCapNotice(formatRun(matches, MAX_RESULT_CAP, { dryRun }), truncated);
    },
  },
  {
    name: "ast_find_rule",
    description:
      "Search code using a YAML rule with advanced combinators (kind, has, inside, follows, precedes, all, any, not). Use when ast_search patterns are insufficient, such as for context-sensitive matches like \"function calls inside a class\" or \"imports followed by usage\". Returns file:line:col with matched code and rule ID.",
    inputSchema: {
      type: "object",
      properties: {
        rule_yaml: {
          type: "string",
          description:
            "YAML rule with id, language, and rule fields. Example:\n" +
            "  id: find-imports\n" +
            "  language: python\n" +
            "  rule:\n" +
            "    pattern: import $MOD\n\n" +
            "For relational rules (has, inside, follows, precedes), add `stopBy: end` " +
            "to search the entire subtree, not just direct children.",
        },
        paths: pathsProperty,
        max_results: maxResultsProperty,
        output_format: outputFormatProperty,
      },
      required: ["rule_yaml"],
    },
    annotations: { title: "Search code by YAML rule", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    _meta: {
      "anthropic/searchHint":
        "YAML rule search with kind/has/inside/follows/precedes combinators for context-sensitive matches",
    },
    call: async (args, ctx = IDLE_CONTEXT) => {
      const a = argReader(args, "ast_find_rule");
      const ruleYaml = a.string("rule_yaml");
      const paths = normalizePaths(a.strings("paths"));
      const maxResults = clampResults(a.integer("max_results", MAX_RESULTS_DEFAULT));
      const format = a.choice("output_format", ["text", "json"], "text");
      const result = await run(["scan", `--inline-rules=${ruleYaml}`, "--json=compact", "--", ...paths], {
        allowExit1: true,
        ...ctx,
      });
      const { matches, truncated } = parseMatches(result.stdout);
      if (matches.length === 0) return "No matches found";
      if (format === "json") return jsonMatches(matches, maxResults, truncated);
      return withCapNotice(formatScan(matches, maxResults), truncated);
    },
  },
  {
    name: "ast_dump_tree",
    description:
      "Dump the syntax tree of a code snippet. Use when building or debugging AST patterns. 'cst' shows full concrete syntax (use on target code), 'pattern' shows how ast-grep interprets a pattern (use when pattern doesn't match), 'ast' gives a simplified view. Returns the tree as text.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Code snippet to visualize" },
        language: { ...languageEnum, description: "Language of the code" },
        format: {
          type: "string",
          enum: ["cst", "ast", "pattern"],
          default: "cst",
          description:
            "Tree format: cst (full concrete syntax tree), ast (omit unnamed nodes), pattern (how ast-grep interprets a pattern)",
        },
      },
      required: ["code", "language"],
    },
    annotations: { title: "Dump a snippet's syntax tree", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    _meta: { "anthropic/searchHint": "dump the AST/CST of a snippet to build or debug an ast-grep pattern" },
    call: async (args, ctx = IDLE_CONTEXT) => {
      const a = argReader(args, "ast_dump_tree");
      const code = a.string("code");
      const language = a.choice("language", LANGUAGES);
      const format = a.choice("format", ["cst", "ast", "pattern"], "cst");
      const result = await run(
        ["run", `--pattern=${code}`, "--lang", language, `--debug-query=${format}`, "--stdin"],
        { input: code, allowExit1: true, ...ctx },
      );
      return result.stderr.trim() || "No syntax tree output. The code may be empty or unparseable.";
    },
  },
  {
    name: "ast_test_rule",
    description:
      "Test whether a YAML rule matches a code snippet. Use before running ast_find_rule across the codebase to validate rule correctness on a small example. Returns matched locations and snippets, or a no-match message with debugging hints.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Code snippet to test against" },
        rule_yaml: {
          type: "string",
          description:
            "YAML rule to test. Must include id, language, and rule fields. Example:\n" +
            "  id: test\n" +
            "  language: python\n" +
            "  rule:\n" +
            "    pattern: print($$$A)",
        },
      },
      required: ["code", "rule_yaml"],
    },
    annotations: { title: "Test a YAML rule on a snippet", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    _meta: {
      "anthropic/searchHint": "validate an ast-grep YAML rule against a snippet before running it repo-wide",
    },
    call: async (args, ctx = IDLE_CONTEXT) => {
      const a = argReader(args, "ast_test_rule");
      const code = a.string("code");
      const ruleYaml = a.string("rule_yaml");
      const result = await run(["scan", `--inline-rules=${ruleYaml}`, "--stdin", "--json=compact"], {
        input: code,
        allowExit1: true,
        ...ctx,
      });
      const { matches, truncated } = parseMatches(result.stdout);
      if (matches.length === 0) return NO_RULE_MATCH;
      return withCapNotice(formatScan(matches, MAX_RESULT_CAP), truncated);
    },
  },
];
