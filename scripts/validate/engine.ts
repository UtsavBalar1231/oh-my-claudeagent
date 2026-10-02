import { join } from "node:path";
import { type Check, type Context, exists, type Outcome, pass, run, type Run, skip, verdict } from "./core.ts";

const FORBIDDEN_CALL = /^(?:prompt\.submit|model\.fork|http\.fetch|store\..+)$/;

export function forbiddenCalls(output: string): string[] {
  const calls = output.split(/\r?\n/).filter((line) => line.includes("calls:"));
  return [...new Set(calls.flatMap((line) => [...line.matchAll(/\$\.([A-Za-z.]+)/g)].map((match) => match[1] ?? "")))].filter((name) =>
    FORBIDDEN_CALL.test(name),
  );
}

export function judgeValidate(result: Run): Outcome {
  if (result.code === 0) return pass("claude plugin validate accepts the manifest and the hooks module");
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

const runs = new WeakMap<Context, Run>();

function validated(ctx: Context): Run {
  let result = runs.get(ctx);
  if (result === undefined) {
    result = validateManifest(ctx);
    runs.set(ctx, result);
  }
  return result;
}

const needsClaude = (judge: (result: Run) => Outcome) => (ctx: Context): Outcome =>
  Bun.which("claude") === null ? skip("claude CLI not on PATH") : judge(validated(ctx));

export const checks: readonly Check[] = [
  { name: "validate-mod", run: needsClaude(judgeValidate) },
  { name: "mod calls line", run: needsClaude(judgeCalls) },
];
