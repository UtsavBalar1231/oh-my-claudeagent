import { type Check, type Context, type Outcome, readText, verdict } from "./core.ts";

// A prompt states what to do now: the model cannot resolve a rename, a release number or a mode
// label from OMCA's past, and the server loads every omca tool up front, so a "deferred" claim is
// stale. The scope is the markdown the model reads plus the TypeScript under servers/ and hooks/,
// scanned whole, since a regex cannot tell a message from a comment.
const MARKDOWN = [
  /^agents\/[^/]+\.md$/,
  /^skills\/.+\.md$/,
  /^output-styles\/[^/]+\.md$/,
  /^templates\/[^/]+\.md$/,
  /^opencode\/overlays\/[^/]+\.md$/,
  /(?:^|\/)AGENTS\.md$/,
];
const SOURCE = [/^servers\/.+\.ts$/, /^hooks\/.+\.ts$/];

type Phrase = { label: string; pattern: RegExp; inSource: boolean };

// A phrase with `inSource: false` is ordinary wording in a code comment, so only markdown is checked.
const PHRASES: readonly Phrase[] = [
  { label: "now part of", pattern: /now part of/i, inSource: true },
  { label: "formerly", pattern: /formerly/i, inSource: true },
  { label: "previously known", pattern: /previously known/i, inSource: true },
  { label: "legacy spelling", pattern: /legacy spelling/i, inSource: true },
  { label: "removed in v", pattern: /\bremoved in v/i, inSource: true },
  { label: "release number (since v2, in v2)", pattern: /\b(?:since|in|from|until|added in|new in|introduced in) v\d/i, inSource: true },
  { label: "OMCA release number", pattern: /\bOMCA v?\d/i, inSource: true },
  { label: "after the port", pattern: /after the port/i, inSource: true },
  { label: "until the servers merge", pattern: /until the servers merge/i, inSource: true },
  { label: "used to be", pattern: /used to be/i, inSource: true },
  { label: "(unchanged", pattern: /\(unchanged/i, inSource: true },
  { label: "Socratic", pattern: /socratic/i, inSource: true },
  { label: "hard cutover", pattern: /hard cutover/i, inSource: true },
  { label: "discovery-deferred", pattern: /discovery-deferred/i, inSource: true },
  { label: "load each through ToolSearch", pattern: /load each through ToolSearch/i, inSource: true },
  { label: "legacy", pattern: /\blegacy\b/i, inSource: false },
  { label: "deprecated", pattern: /\bdeprecated\b/i, inSource: false },
  { label: "no longer", pattern: /\bno longer\b/i, inSource: false },
  { label: "previously", pattern: /\bpreviously\b/i, inSource: false },
  { label: "renamed", pattern: /\brenamed\b/i, inSource: false },
  { label: "replaced by", pattern: /\breplaced by\b/i, inSource: false },
  { label: "was removed", pattern: /\bwas removed\b/i, inSource: false },
];

type Allowed = { file: string; phrase: string; line: string; reason: string };

// An entry excuses the lines of one file that match one phrase and contain `line`. An entry for a
// scanned file that matches no line fails, so the list cannot outlive the wording it excuses.
export const ALLOWED: readonly Allowed[] = [
  {
    file: "agents/hephaestus.md",
    phrase: "renamed",
    line: "a renamed type",
    reason: "a build error caused by a rename in the user's own code",
  },
  {
    file: "agents/executor.md",
    phrase: "legacy",
    line: "legacy fallbacks",
    reason: "the instruction not to add compatibility code the task does not require",
  },
  {
    file: "agents/sisyphus.md",
    phrase: "legacy",
    line: "Legacy/Chaotic",
    reason: "a class of the user's codebase that sisyphus assesses",
  },
  {
    file: "skills/debugging/references/methodology.md",
    phrase: "no longer",
    line: "the original repro no longer fails",
    reason: "the debugging verification step",
  },
  {
    file: "skills/init-deep/SKILL.md",
    phrase: "deprecated",
    line: "forbidden or deprecated patterns",
    reason: "comments that the user's repository carries",
  },
  {
    file: "skills/refactor/SKILL.md",
    phrase: "deprecated",
    line: "using deprecated API",
    reason: "a refactor target in the user's code",
  },
  {
    file: "skills/refactor/SKILL.md",
    phrase: "deprecated",
    line: "Deprecated Code & Library Migration",
    reason: "the section on migrating off a deprecated API in the user's code",
  },
  {
    file: "skills/remove-ai-slops/references/categories.md",
    phrase: "previously",
    line: "previously degraded gracefully",
    reason: "the behavior change a cleanup must not cause",
  },
  {
    file: "skills/remove-ai-slops/references/categories.md",
    phrase: "previously",
    line: "Previously this used a different algorithm",
    reason: "the example of a history comment that the skill defines as slop",
  },
  {
    file: "skills/start-work/SKILL.md",
    phrase: "no longer",
    line: "diff no longer fits",
    reason: "a context-capacity condition for choosing a reviewer",
  },
];

function scanned(ctx: Context): string[] {
  return ctx
    .tracked()
    .filter((path) => MARKDOWN.some((pattern) => pattern.test(path)) || (SOURCE.some((pattern) => pattern.test(path)) && !path.endsWith(".spec.ts")));
}

function promptHistory(ctx: Context): Outcome {
  const files = scanned(ctx);
  const used = new Set<Allowed>();
  const problems: string[] = [];
  for (const file of files) {
    const isSource = file.endsWith(".ts");
    readText(ctx.root, file)
      .split(/\r?\n/)
      .forEach((line, index) => {
        for (const { label, pattern, inSource } of PHRASES) {
          if (isSource && !inSource) continue;
          const found = pattern.exec(line);
          if (found === null) continue;
          const entry = ALLOWED.find((allowed) => allowed.file === file && allowed.phrase === label && line.includes(allowed.line));
          if (entry !== undefined) used.add(entry);
          else problems.push(`${file}:${index + 1}: ${label} '${found[0]}'`);
        }
      });
  }
  for (const entry of ALLOWED) {
    if (files.includes(entry.file) && !used.has(entry)) {
      problems.push(`allowlist entry for ${entry.file} (${entry.phrase}, '${entry.line}') matches no line`);
    }
  }
  return verdict(problems, `no history phrasing in ${files.length} prompt files`);
}

export const checks: readonly Check[] = [{ name: "prompt history", run: promptHistory }];
