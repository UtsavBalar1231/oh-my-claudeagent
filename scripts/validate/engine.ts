import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageTree } from "../package.ts";
import { type Check, type Context, envWithout, type Outcome, pass, run, type Run, skip, verdict } from "./core.ts";
import { ENGINE_TYPES, writerVersion } from "./manifest.ts";

const FORBIDDEN_CALL = /^(?:prompt\.submit|model\.fork|http\.fetch|store\..+)$/;

export function forbiddenCalls(output: string): string[] {
  const calls = output.split(/\r?\n/).filter((line) => line.includes("calls:"));
  return [...new Set(calls.flatMap((line) => [...line.matchAll(/\$\.([A-Za-z.]+)/g)].map((match) => match[1] ?? "")))].filter((name) =>
    FORBIDDEN_CALL.test(name),
  );
}

export function judgeValidate(result: Run, subject = "the manifest and the hooks module"): Outcome {
  if (result.code === 0) return pass(`claude plugin validate accepts ${subject}`);
  const reason = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/).slice(0, 8).join(" | ");
  return { status: "fail", detail: `claude plugin validate exited ${result.code}: ${reason}` };
}

export function judgeCalls(result: Run): Outcome {
  const found = forbiddenCalls(`${result.stdout}\n${result.stderr}`);
  return verdict(
    found.map((name) => `the mod calls $.${name}`),
    "the mod's calls: line holds no prompt.submit, model.fork, store.* or http.fetch",
  );
}

type Runs = { manifest: Run; marketplace: Run };

const runs = new WeakMap<Context, Runs>();

// The checkout holds an untracked CLAUDE.md that --strict rejects, so the runs read a packaged
// copy, which is also what an install reads. The manifest path validates the plugin alone; the
// plugin root validates the marketplace and the plugin it lists.
function validated(ctx: Context): Runs {
  const cached = runs.get(ctx);
  if (cached !== undefined) return cached;
  const scratch = mkdtempSync(join(tmpdir(), "omca-engine-"));
  try {
    const packaged = join(scratch, "plugin");
    packageTree(ctx.root, packaged, ctx.tracked());
    const result = {
      manifest: run(["claude", "plugin", "validate", ".claude-plugin/plugin.json", "--strict"], packaged),
      marketplace: run(["claude", "plugin", "validate", ".", "--strict"], packaged),
    };
    runs.set(ctx, result);
    return result;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export const SKILL_TYPES = "**/bundled-skills/*/*/plugin-authoring/types/claude-code.d.ts";
// What follows depends on print mode and the account, so the comparison stops here.
const TOOLS_MARKER = "// The inputs of the built-in tools";

/** The generated file up to the line that starts the tools section, with CRLF normalized, or undefined when no line starts it. */
export function coreTypes(generated: string): string | undefined {
  const normalized = generated.replaceAll("\r\n", "\n");
  const at = `\n${normalized}`.indexOf(`\n${TOOLS_MARKER}`);
  return at === -1 ? undefined : normalized.slice(0, at);
}

export function firstDifferentLine(a: string, b: string): number {
  const left = a.split("\n");
  const right = b.split("\n");
  let line = 0;
  while (line < left.length && line < right.length && left[line] === right[line]) line++;
  return line + 1;
}

export function judgeSkillTypes(generated: string | undefined, committed: string, scratchListing: readonly string[]): Outcome {
  const listing = `the scratch temp folder holds: ${scratchListing.join(", ") || "nothing"}`;
  if (generated === undefined) return { status: "fail", detail: `no file matches ${SKILL_TYPES}; ${listing}` };
  const core = coreTypes(generated);
  if (core === undefined) return { status: "fail", detail: `the file matching ${SKILL_TYPES} has no line starting "${TOOLS_MARKER}"; ${listing}` };
  const expected = committed.replaceAll("\r\n", "\n");
  if (core !== expected) {
    return {
      status: "fail",
      detail: `${ENGINE_TYPES} differs from the plugin-authoring skill's types at line ${firstDifferentLine(expected, core)}; run \`just types\``,
    };
  }
  return pass(`${ENGINE_TYPES} matches the plugin-authoring skill's types up to the tools section`);
}

export const versionSkip = (installed: string, writer: string | undefined): Outcome =>
  skip(`claude ${installed} is installed and ${ENGINE_TYPES} was written by Claude Code ${writer ?? "an unnamed version"}; the comparison needs the same version`);

// The skill writes its types under Claude Code's temp root as it loads, before the dead port fails
// the request. CLAUDE_CODE_TMPDIR names that root on every OS; without it macOS ignores TMPDIR.
function skillTypes(ctx: Context): Outcome {
  const committed = readFileSync(join(ctx.root, ENGINE_TYPES), "utf8");
  const writer = writerVersion(committed);
  const installed = run(["claude", "--version"], ctx.root).stdout.trim().split(/\s+/)[0] ?? "";
  if (installed !== writer) return versionSkip(installed, writer);
  const scratch = mkdtempSync(join(tmpdir(), "omca-skill-types-"));
  try {
    const temp = join(scratch, "tmp");
    const config = join(scratch, "config");
    const cwd = join(scratch, "cwd");
    for (const dir of [temp, config, cwd]) mkdirSync(dir);
    writeFileSync(join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
    run(["claude", "-p", "/plugin-authoring"], cwd, {
      env: envWithout(/^(CLAUDE|ANTHROPIC|OMCA|GIT_)/, {
        CLAUDE_CODE_TMPDIR: temp,
        TMPDIR: temp,
        TEMP: temp,
        TMP: temp,
        CLAUDE_CONFIG_DIR: config,
        ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
        ANTHROPIC_API_KEY: "dummy",
        CLAUDE_CODE_MAX_RETRIES: "0",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      }),
    });
    const found = new Bun.Glob(SKILL_TYPES).scanSync({ cwd: temp, dot: true }).next();
    const listing = readdirSync(temp, { recursive: true, encoding: "utf8" }).map((path) => path.replaceAll("\\", "/")).sort();
    return judgeSkillTypes(found.done ? undefined : readFileSync(join(temp, found.value), "utf8"), committed, listing);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const needsClaude = (check: (ctx: Context) => Outcome) => (ctx: Context): Outcome =>
  Bun.which("claude") === null ? skip("claude CLI not on PATH") : check(ctx);

export const checks: readonly Check[] = [
  { name: "validate manifest", run: needsClaude((ctx) => judgeValidate(validated(ctx).manifest, "the packaged manifest and hooks module under --strict")) },
  { name: "validate marketplace", run: needsClaude((ctx) => judgeValidate(validated(ctx).marketplace, "the packaged marketplace under --strict")) },
  { name: "mod calls line", run: needsClaude((ctx) => judgeCalls(validated(ctx).manifest)) },
  { name: "engine types match the skill", run: needsClaude(skillTypes) },
];
