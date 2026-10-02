#!/usr/bin/env bun
// Copies the shipped plugin tree into <dest>, replacing what an earlier copy left there.
// With --dry-run it prints the files that would ship, one path per line, and writes nothing.
//
// Usage: bun scripts/package.ts <dest_dir> [--version <N.N.N>]
//        bun scripts/package.ts --dry-run
import {
  copyFileSync,
  type Dirent,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

const USAGE = "Usage: bun scripts/package.ts <dest_dir> [--version <N.N.N>]\n       bun scripts/package.ts --dry-run";

// A pattern with a trailing slash names a directory. A pattern without a leading slash
// matches the last path components at any depth, as rsync's --exclude does.
export const EXCLUDES = [
  ".git/",
  ".omca/",
  "CLAUDE.md",
  ".claude/",
  "benchmarks/",
  "docs/design/",
  "tests/",
  "scripts/qa/",
  "node_modules/",
] as const;

type Rule = { directoryOnly: boolean; segments: RegExp[] };

const segmentPattern = (segment: string): RegExp =>
  new RegExp(`^${segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);

const RULES: Rule[] = EXCLUDES.map((pattern) => ({
  directoryOnly: pattern.endsWith("/"),
  segments: pattern.replace(/\/$/, "").split("/").map(segmentPattern),
}));

function isExcluded(parts: readonly string[], isDirectory: boolean): boolean {
  return RULES.some(({ directoryOnly, segments }) => {
    if (directoryOnly && !isDirectory) return false;
    const tail = parts.slice(parts.length - segments.length);
    return tail.length === segments.length && segments.every((segment, i) => segment.test(tail[i] ?? ""));
  });
}

const isLeaf = (entry: Dirent): boolean => !entry.isDirectory();

export function listPackageFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (parts: string[]): void => {
    for (const entry of readdirSync(join(root, ...parts), { withFileTypes: true })) {
      const next = [...parts, entry.name];
      if (isExcluded(next, !isLeaf(entry))) continue;
      if (isLeaf(entry)) files.push(next.join("/"));
      else walk(next);
    }
  };
  walk([]);
  return files.sort();
}

function prune(dest: string, parts: string[], files: ReadonlySet<string>, directories: ReadonlySet<string>): void {
  for (const entry of readdirSync(join(dest, ...parts), { withFileTypes: true })) {
    const next = [...parts, entry.name];
    if (isExcluded(next, !isLeaf(entry))) continue;
    const relative = next.join("/");
    const path = join(dest, ...next);
    if (isLeaf(entry)) {
      if (!files.has(relative)) rmSync(path, { force: true });
    } else if (directories.has(relative)) {
      prune(dest, next, files, directories);
    } else {
      rmSync(path, { recursive: true, force: true });
    }
  }
}

export function packageTree(root: string, dest: string): string[] {
  const files = listPackageFiles(root);
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

export type Outcome = { code: number; stdout: string; stderr: string };

const OPTIONS = { "dry-run": { type: "boolean" }, version: { type: "string" } } as const;
const parse = (args: string[]) => parseArgs({ args, options: OPTIONS, allowPositionals: true });

export function main(args: string[], root: string): Outcome {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(args);
  } catch (error) {
    return { code: 1, stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\n${USAGE}\n` };
  }
  const { values, positionals } = parsed;
  if (values["dry-run"]) return { code: 0, stdout: listPackageFiles(root).map((file) => `${file}\n`).join(""), stderr: "" };
  const [dest, ...extra] = positionals;
  if (dest === undefined || extra.length > 0) {
    const problem = dest === undefined ? "Missing <dest_dir>" : `Unexpected argument: ${extra[0]}`;
    return { code: 1, stdout: "", stderr: `${problem}\n${USAGE}\n` };
  }
  packageTree(root, dest);
  return { code: 0, stdout: `packaging v${values.version ?? manifestVersion(root)} → ${dest}\n`, stderr: "" };
}

if (import.meta.main) {
  const { code, stdout, stderr } = main(Bun.argv.slice(2), join(import.meta.dir, ".."));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
