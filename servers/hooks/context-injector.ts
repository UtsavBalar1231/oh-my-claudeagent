import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isHookDisabled } from "../../src/core/kill-switch.ts";
import { type Platform, samePath, toPlatform } from "../../src/core/path.ts";
import { docPart, pack, type Part, parseRule, type Rule, rulePart } from "../../src/core/rules.ts";
import { pluginRoot } from "../plugin-root.ts";
import type { Handler } from "./registry.ts";

type RuleFile = { readonly path: string; mtimeMs: number | undefined; rule: Rule | undefined };
type Group = { readonly key: string; readonly parts: readonly Part[] };

const PLATFORM = toPlatform(process.platform);
const indexes = new Map<string, { stamp: string; files: RuleFile[] }>();

const statOf = (path: string) => statSync(path, { throwIfNoEntry: false });
const isFile = (path: string): boolean => statOf(path)?.isFile() === true;
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const filePathOf = (toolInput: unknown): string =>
  typeof toolInput === "object" && toolInput !== null && "file_path" in toolInput && typeof toolInput.file_path === "string"
    ? toolInput.file_path
    : "";

export function* upTo(platform: Platform, dir: string, root: string): Generator<string> {
  for (let current = dir; ; current = dirname(current)) {
    yield current;
    if (samePath(platform, current, root) || dirname(current) === current) return;
  }
}

// A linked worktree's `.git` is a file, so this tests for any entry, and a file inside a
// worktree never takes its rules or AGENTS.md from the repository the worktree belongs to.
function projectRootOf(dir: string, fallback: string): string {
  for (let current = dir; dirname(current) !== current; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) return current;
  }
  return fallback;
}

function listRuleFiles(dirs: readonly string[]): RuleFile[] {
  const seen = new Set<string>();
  const files: RuleFile[] = [];
  for (const dir of dirs) {
    if (statOf(dir)?.isDirectory() !== true) continue;
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (!name.endsWith(".md") || seen.has(name) || !isFile(path)) continue;
      seen.add(name);
      files.push({ path, mtimeMs: Number.NaN, rule: undefined });
    }
  }
  return files;
}

function rulesOf(root: string): RuleFile[] {
  const dirs = [join(root, ".omca", "rules"), join(pluginRoot(), "rules")];
  const key = dirs.join("\0");
  const stamp = dirs.map((dir) => statOf(dir)?.mtimeMs).join("\0");
  let index = indexes.get(key);
  if (index?.stamp !== stamp) {
    index = { stamp, files: listRuleFiles(dirs) };
    indexes.set(key, index);
  }
  // Editing a rule in place leaves its directory's mtime alone, so each file is checked too.
  for (const file of index.files) {
    const mtimeMs = statOf(file.path)?.mtimeMs;
    if (mtimeMs === file.mtimeMs) continue;
    file.mtimeMs = mtimeMs;
    file.rule = mtimeMs === undefined ? undefined : parseRule(readFileSync(file.path, "utf8"));
  }
  return index.files;
}

const hasProjectClaudeMd = (dir: string, root: string): boolean =>
  [...upTo(PLATFORM, dir, root)].some((current) =>
    ["CLAUDE.md", join(".claude", "CLAUDE.md"), "CLAUDE.local.md"].some((name) => isFile(join(current, name))),
  );

function docGroups(fileDir: string, root: string, injected: ReadonlySet<string>): Group[] {
  // Native AGENTS.md loading is documented as active only while no project CLAUDE.md is on the
  // path, and no hook-readable signal says whether it is live, so skipping is opt-in.
  const names = process.env.OMCA_NATIVE_AGENTS_MD === "1" && !hasProjectClaudeMd(fileDir, root) ? ["README.md"] : ["AGENTS.md", "README.md"];
  return [...upTo(PLATFORM, fileDir, root)].flatMap((dir) => {
    const key = `dir\0${dir}\0${statOf(join(dir, "AGENTS.md"))?.mtimeMs ?? ""}`;
    if (injected.has(key)) return [];
    const parts = names.flatMap((name) => {
      const path = join(dir, name);
      return isFile(path) ? [docPart({ name, dir, path }, readFileSync(path, "utf8"))] : [];
    });
    return parts.length === 0 ? [] : [{ key, parts }];
  });
}

function ruleGroups(fileName: string, root: string, injected: ReadonlySet<string>): Group[] {
  return rulesOf(root).flatMap(({ path, rule }) => {
    if (rule === undefined || !new Bun.Glob(rule.pattern).match(fileName)) return [];
    const key = `rule\0${path}\0${sha256(rule.body)}`;
    return injected.has(key) ? [] : [{ key, parts: [rulePart(rule, path)] }];
  });
}

export const handle: Handler = (payload, { root, session }) => {
  const tool = payload.tool_name;
  if ((tool !== "Read" && tool !== "Write" && tool !== "Edit") || isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "context-injector")) return;
  const filePath = filePathOf(payload.tool_input);
  if (!isAbsolute(filePath) || !isFile(filePath)) return;
  const fileDir = dirname(filePath);
  const projectRoot = projectRootOf(fileDir, root);
  const injected = session === undefined ? new Set<string>() : (session.injectedContext ??= new Set());
  const groups = [
    ...(tool === "Read" ? docGroups(fileDir, projectRoot, injected) : []),
    ...ruleGroups(basename(filePath), projectRoot, injected),
  ];
  const { context, kept } = pack(groups.flatMap(({ parts }) => parts));
  for (const { key, parts } of groups) if (parts.every((part) => kept.has(part))) injected.add(key);
  return context === "" ? undefined : { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } };
};
