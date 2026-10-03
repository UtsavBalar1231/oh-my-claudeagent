import { join } from "node:path";
import { type Check, type Context, exists, type Outcome, pass, run, type Run, skip, verdict } from "./core.ts";

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

// The manifest path is the target that opens register.ts; the repository root reads only
// marketplace.json. A CLAUDE.md at the plugin root draws a warning that --strict turns into an error.
function validateManifest(ctx: Context): Run {
  const strict = exists(join(ctx.root, "CLAUDE.md")) ? [] : ["--strict"];
  return run(["claude", "plugin", "validate", ".claude-plugin/plugin.json", ...strict], ctx.root);
}

// The repository root reads only marketplace.json, so this run does not open the hooks module.
function validateMarketplace(ctx: Context): Run {
  return run(["claude", "plugin", "validate", ".", "--strict"], ctx.root);
}

const runs = new WeakMap<Context, Run>();

function validated(ctx: Context): Run {
  let result = runs.get(ctx);
  if (result === undefined) {
    result = validateManifest(ctx);
    runs.set(ctx, result);
  }
  return result;
}

const needsClaude = (check: (ctx: Context) => Outcome) => (ctx: Context): Outcome =>
  Bun.which("claude") === null ? skip("claude CLI not on PATH") : check(ctx);

export const checks: readonly Check[] = [
  { name: "validate manifest", run: needsClaude((ctx) => judgeValidate(validated(ctx))) },
  { name: "validate marketplace", run: needsClaude((ctx) => judgeValidate(validateMarketplace(ctx), "the marketplace under --strict")) },
  { name: "mod calls line", run: needsClaude((ctx) => judgeCalls(validated(ctx))) },
];
