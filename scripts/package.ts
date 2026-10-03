#!/usr/bin/env bun
// Copies the shipped plugin tree into <dest>, replacing what an earlier copy left there. Only files
// git tracks ship, so an untracked file in the working tree never reaches an install.
// With --dry-run it prints the files that would ship, one path per line, and writes nothing.
//
// Usage: bun scripts/package.ts <dest_dir>
//        bun scripts/package.ts --dry-run
import {
  copyFileSync,
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { gitTracked, type Run } from "./validate/core.ts";

const USAGE = "Usage: bun scripts/package.ts <dest_dir>\n       bun scripts/package.ts --dry-run";

// A pattern with a trailing slash names a directory. A pattern with a leading slash matches only
// from the root. Any other pattern matches the last path components at any depth, as rsync's
// --exclude does. Claude Code installs npm packages whenever the plugin root holds package.json and
// a lockfile, so the root manifests, lockfile and typecheck configs stay out of the shipped tree.
export const EXCLUDES = [
  ".git/",
  ".github/",
  ".omca/",
  "CLAUDE.md",
  ".claude/",
  "benchmarks/",
  "tests/",
  "*.spec.ts",
  "node_modules/",
  "/scripts/",
  "/justfile",
  "/.pre-commit-config.yaml",
  "/.editorconfig",
  "/CONTRIBUTING.md",
  "/package.json",
  "/bun.lock",
  "/bunfig.toml",
  "/tsconfig.json",
  "/tsconfig.runtime.json",
  "/.oxlintrc.json",
  "/opencode/",
  "/.opencode/",
  "/video/",
] as const;

/** Files that ship although an exclude covers them: `/oh-my-claudeagent:omca-setup` runs this script from the install. */
export const KEEP = ["scripts/setup-statusline.ts"] as const;

type Rule = { directoryOnly: boolean; anchored: boolean; segments: RegExp[] };

const segmentPattern = (segment: string): RegExp =>
  new RegExp(`^${segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);

const RULES: Rule[] = EXCLUDES.map((pattern) => ({
  directoryOnly: pattern.endsWith("/"),
  anchored: pattern.startsWith("/"),
  segments: pattern.replace(/^\//, "").replace(/\/$/, "").split("/").map(segmentPattern),
}));

function isExcluded(parts: readonly string[], isDirectory: boolean): boolean {
  return RULES.some(({ directoryOnly, anchored, segments }) => {
    if (directoryOnly && !isDirectory) return false;
    if (anchored && parts.length !== segments.length) return false;
    const tail = parts.slice(parts.length - segments.length);
    return tail.length === segments.length && segments.every((segment, i) => segment.test(tail[i] ?? ""));
  });
}

const isLeaf = (entry: Dirent): boolean => !entry.isDirectory();

const isShipped = (path: string): boolean => {
  if ((KEEP as readonly string[]).includes(path)) return true;
  const parts = path.split("/");
  return !parts.some((_, depth) => isExcluded(parts.slice(0, depth + 1), depth < parts.length - 1));
};

export const listPackageFiles = (tracked: readonly string[]): string[] => tracked.filter(isShipped).sort();

function prune(dest: string, parts: string[], files: ReadonlySet<string>, directories: ReadonlySet<string>): void {
  for (const entry of readdirSync(join(dest, ...parts), { withFileTypes: true })) {
    const next = [...parts, entry.name];
    const shipped = next.join("/");
    const path = join(dest, ...next);
    if (isLeaf(entry) ? files.has(shipped) : directories.has(shipped)) {
      if (!isLeaf(entry)) prune(dest, next, files, directories);
    } else if (!isExcluded(next, !isLeaf(entry))) {
      rmSync(path, { recursive: true, force: true });
    }
  }
}

const PLUGIN_NAME = "oh-my-claudeagent";

const canonical = (path: string): string => (existsSync(path) ? realpathSync(path) : resolve(path));

function readName(dir: string): unknown {
  try {
    return JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8")).name;
  } catch {
    return undefined;
  }
}

/** Why `dest` must not be replaced: packaging deletes whatever in it is not on the shipped list. */
export function refusal(root: string, dest: string): string | undefined {
  const fromDest = relative(canonical(dest), canonical(root));
  const outside = isAbsolute(fromDest) || fromDest === ".." || fromDest.startsWith(`..${sep}`);
  if (!outside) return `${dest} is the repository or a directory that holds it`;
  if (!existsSync(dest) || readdirSync(dest).length === 0) return undefined;
  if (readName(dest) === PLUGIN_NAME) return undefined;
  return `${dest} is not empty and is not an earlier ${PLUGIN_NAME} package`;
}

/** Copies the shipped files of `root` to `dest`; `tracked` lists them for a tree that is not a repository, such as an export of one commit. */
export function packageTree(root: string, dest: string, tracked: readonly string[] = gitTracked(root)): string[] {
  const refused = refusal(root, dest);
  if (refused !== undefined) throw new Error(`refusing to package into ${refused}`);
  const files = listPackageFiles(tracked);
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.split("/").slice(0, -1);
    for (let depth = 1; depth <= parts.length; depth++) directories.add(parts.slice(0, depth).join("/"));
  }
  mkdirSync(dest, { recursive: true });
  prune(dest, [], new Set(files), directories);
  for (const file of files) {
    const from = join(root, file);
    const to = join(dest, file);
    mkdirSync(dirname(to), { recursive: true });
    rmSync(to, { force: true });
    if (lstatSync(from).isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else copyFileSync(from, to);
  }
  return files;
}

function manifestVersion(root: string): string {
  try {
    return String(JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")).version);
  } catch {
    return "unknown";
  }
}

const OPTIONS = { "dry-run": { type: "boolean" } } as const;
const parse = (args: string[]) => parseArgs({ args, options: OPTIONS, allowPositionals: true });

export function main(args: string[], root: string, cwd: string = process.cwd()): Run {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(args);
  } catch (error) {
    return { code: 1, stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\n${USAGE}\n` };
  }
  const { values, positionals } = parsed;
  if (values["dry-run"]) return { code: 0, stdout: listPackageFiles(gitTracked(root)).map((file) => `${file}\n`).join(""), stderr: "" };
  const [dest, ...extra] = positionals;
  if (dest === undefined || extra.length > 0) {
    const problem = dest === undefined ? "Missing <dest_dir>" : `Unexpected argument: ${extra[0]}`;
    return { code: 1, stdout: "", stderr: `${problem}\n${USAGE}\n` };
  }
  try {
    packageTree(root, resolve(cwd, dest));
  } catch (error) {
    return { code: 1, stdout: "", stderr: `ERROR: ${error instanceof Error ? error.message : String(error)}\n` };
  }
  return { code: 0, stdout: `packaging v${manifestVersion(root)} → ${dest}\n`, stderr: "" };
}

if (import.meta.main) {
  const { code, stdout, stderr } = main(Bun.argv.slice(2), join(import.meta.dir, ".."));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
