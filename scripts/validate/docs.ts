import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listPackageFiles } from "../package.ts";
import { type Check, type Context, exists, listFiles, type Outcome, pass, readText, run, skip, verdict } from "./core.ts";

const ALLOWLIST = "scripts/validate/allowlist.txt";
const SCAN_ROOTS = ["agents/", "skills/", "scripts/", "servers/", "templates/", "output-styles/", "docs/"];
const SCAN_FILES = ["README.md", "OMCA.md"];

// "/home/user" and "/Users/user" are documentation placeholders, filtered after matching so a
// real account named "user" still shows up in the pattern.
const PLACEHOLDERS = new Set(["/home/user", "/Users/user"]);
const withoutTrailingSlash = (path: string): string => path.replace(/\/$/, "");
const LEAK_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
  { label: "home-path literal", pattern: /(?:\/home\/|\/Users\/)[A-Za-z0-9_.-]+(?:\/|(?=$|[\s"'`)\]}>]))/g },
  { label: "windows home-path literal", pattern: /C:\\Users\\[A-Za-z0-9_.-]+/g },
  // A *_TOKEN, *_API_KEY or *_SECRET assignment whose value is not an obvious placeholder.
  { label: "credential-looking literal", pattern: /[A-Z0-9_]*(?:TOKEN|API_KEY|SECRET)=[^$<"\s][^"\s]*/g },
  { label: "bearer-token-looking literal", pattern: /Bearer [A-Za-z0-9_-]{20,}/g },
];

function allowlisted(ctx: Context): Set<string> {
  const path = join(ctx.root, ALLOWLIST);
  if (!existsSync(path)) return new Set();
  return new Set(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map(withoutTrailingSlash),
  );
}

function readable(ctx: Context, path: string): string | undefined {
  const source = readFileSync(join(ctx.root, path), "utf8");
  return source.includes("\0") ? undefined : source;
}

function depersonalization(ctx: Context): Outcome {
  const files = ctx
    .tracked()
    .filter((path) => path !== ALLOWLIST && (SCAN_FILES.includes(path) || SCAN_ROOTS.some((root) => path.startsWith(root))));
  if (files.length === 0) return { status: "fail", detail: "no tracked files found under the scan roots" };
  const allowed = allowlisted(ctx);
  const problems: string[] = [];
  for (const file of files) {
    const lines = readable(ctx, file)?.split(/\r?\n/) ?? [];
    lines.forEach((line, index) => {
      for (const { label, pattern } of LEAK_PATTERNS) {
        for (const [matched] of line.matchAll(pattern)) {
          const bare = withoutTrailingSlash(matched);
          if (PLACEHOLDERS.has(bare) || allowed.has(`${file}:${bare}`)) continue;
          problems.push(`${file}:${index + 1}: ${label} '${matched}'`);
        }
      }
    });
  }
  return verdict(problems, `no home-path, credential or bearer-token literals in ${files.length} tracked shipped files`);
}

const DOCS = ["README.md", "OMCA.md", "docs/CONTRIBUTING.md"];
const TOP_LEVEL = new Set([
  "agents", "bin", "docs", "hooks", "opencode", "output-styles", "rules", "scripts", "servers", "skills", "statusline",
  "templates", "tests", ".claude", ".claude-plugin", ".github", ".omca",
]);
const REMOVAL_NOTE = /no longer exist|does not exist|removed in|neither script exists|not currently used/i;

function documentsRemoval(lines: readonly string[], lineNumber: number): boolean {
  return lines.slice(Math.max(0, lineNumber - 4), lineNumber + 3).some((line) => REMOVAL_NOTE.test(line));
}

function docsAccuracy(ctx: Context): Outcome {
  const justfile = join(ctx.root, "justfile");
  if (!exists(justfile)) return { status: "fail", detail: `justfile missing at ${justfile}` };
  const recipes = new Set(
    readFileSync(justfile, "utf8")
      .split(/\r?\n/)
      .flatMap((line) => /^[a-zA-Z][a-zA-Z0-9_-]*/.exec(line)?.[0] ?? []),
  );
  const tracked = new Set(ctx.tracked());
  const problems: string[] = [];
  let checked = 0;
  for (const doc of DOCS) {
    if (!exists(join(ctx.root, doc))) continue;
    const lines = readText(ctx.root, doc).split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const [, recipe = ""] of line.matchAll(/`just ([a-zA-Z0-9_-]+)/g)) {
        checked += 1;
        if (!recipes.has(recipe)) problems.push(`${doc}:${index + 1} cites 'just ${recipe}' which is not a justfile recipe`);
      }
      for (const [, candidate = ""] of line.matchAll(/`([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)`/g)) {
        // A scaffold example such as agents/name.md is a template, not a file.
        if (candidate.includes("/name.") || candidate.includes("/name/")) continue;
        if (!TOP_LEVEL.has(candidate.split("/")[0] ?? "")) continue;
        checked += 1;
        if (tracked.has(candidate)) continue;
        // A gitignored path is the reader's own runtime state, not part of this tree.
        if (run(["git", "check-ignore", "-q", candidate], ctx.root).code === 0) continue;
        if (documentsRemoval(lines, index + 1)) continue;
        problems.push(`${doc}:${index + 1} references '${candidate}' which does not exist in the repo`);
      }
    });
  }
  return verdict(problems, `${checked} recipe and path references in ${DOCS.join(", ")} resolve`);
}

function skillReferences(ctx: Context): Outcome {
  const problems: string[] = [];
  let skills = 0;
  for (const dir of listFiles(ctx.skillsDir, "")) {
    const referencesDir = join(dir, "references");
    const skillFile = join(dir, "SKILL.md");
    if (!exists(referencesDir) || !exists(skillFile)) continue;
    skills += 1;
    const skill = readFileSync(skillFile, "utf8");
    const name = dir.split(/[\\/]/).pop() ?? dir;
    for (const mention of new Set(skill.match(/references\/[A-Za-z0-9_./-]+\.md/g) ?? [])) {
      if (!exists(join(dir, mention))) problems.push(`${name} SKILL.md references ${mention} but it is missing`);
    }
    for (const entry of readdirSync(referencesDir, { recursive: true, encoding: "utf8" })) {
      const relativePath = `references/${entry.replaceAll("\\", "/")}`;
      if (entry.endsWith(".md") && !skill.includes(relativePath)) problems.push(`${name} ${relativePath} is not referenced from SKILL.md`);
    }
  }
  if (skills === 0) return skip("no skills with a references/ directory found");
  return verdict(problems, `${skills} skills: every references/ file is mentioned and every mention exists`);
}

function claudeMdTemplate(ctx: Context): Outcome {
  const template = "templates/claudemd.md";
  const reader = "servers/hooks/guidance.ts";
  if (!exists(join(ctx.root, reader)) || !readText(ctx.root, reader).includes('"templates", "claudemd.md"')) {
    return { status: "fail", detail: `${reader} no longer reads ${template}` };
  }
  if (!exists(join(ctx.root, template))) return { status: "fail", detail: `${template} is missing` };
  if (!listPackageFiles(ctx.tracked()).includes(template)) {
    return { status: "fail", detail: `scripts/package.ts does not ship ${template}, check EXCLUDES` };
  }
  return pass(`${reader} reads ${template} and scripts/package.ts ships it`);
}

// Payload fields that never existed, or that Write and Edit payloads omit, so a handler reading
// one gets a constant.
const PHANTOM_FIELDS = [/\btool_error\b/, /\btool_result\??\.(?:error|success)\b/, /\btool_response\??\.success\b/];

function phantomFields(ctx: Context): Outcome {
  const handlers = ctx
    .tracked()
    .filter((path) => /^(?:hooks|servers\/hooks)\/[^/]+\.ts$/.test(path) && !path.endsWith(".spec.ts"));
  if (handlers.length === 0) return { status: "fail", detail: "no hook handler files found to scan" };
  const problems = handlers.flatMap((file) =>
    readText(ctx.root, file)
      .split(/\r?\n/)
      .flatMap((line, index) => (PHANTOM_FIELDS.some((pattern) => pattern.test(line)) ? [`${file}:${index + 1}: ${line.trim()}`] : [])),
  );
  return verdict(problems, `no phantom payload field names in ${handlers.length} hook handlers`);
}

export const checks: readonly Check[] = [
  { name: "skill references", run: skillReferences },
  { name: "claudemd template", run: claudeMdTemplate },
  { name: "phantom payload fields", run: phantomFields },
  { name: "depersonalization", run: depersonalization },
  { name: "docs accuracy", run: docsAccuracy },
];
