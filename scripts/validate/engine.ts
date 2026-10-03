import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageTree } from "../package.ts";
import { type Check, type Context, type Outcome, pass, run, type Run, skip, verdict } from "./core.ts";

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
// copy, which is also what an install reads. The manifest path is the target that opens
// register.ts; the plugin root reads only marketplace.json.
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

const needsClaude = (check: (ctx: Context) => Outcome) => (ctx: Context): Outcome =>
  Bun.which("claude") === null ? skip("claude CLI not on PATH") : check(ctx);

export const checks: readonly Check[] = [
  { name: "validate manifest", run: needsClaude((ctx) => judgeValidate(validated(ctx).manifest, "the packaged manifest and hooks module under --strict")) },
  { name: "validate marketplace", run: needsClaude((ctx) => judgeValidate(validated(ctx).marketplace, "the packaged marketplace under --strict")) },
  { name: "mod calls line", run: needsClaude((ctx) => judgeCalls(validated(ctx).manifest)) },
];
