import { isSlotRecent, ledgerCoversSlot } from "./evidence.ts";

export type Verification = { command: string; at: number; exit_code: number | null };

// A runner missing from this list records nothing and the gate stays silent, so a miss is a
// false negative, never a false block; the list grows only when a real runner goes unrecorded.
// `test` and `lint` take a suffix because the suffix narrows the check; `build` and `fmt`
// cannot, since build-and-deploy ships and fmt rewrites. The separator anchor keeps a flag
// value such as `--include=pytest` from reading as an invocation.
const RUNNER =
  /(^|[;&|(])\s*(just\s+((test|lint)(-[A-Za-z0-9_]+)*|ci|fmt-check|typecheck|build)|(npm|pnpm|yarn|bun)\s+(test|run\s+(test|lint|build))|pytest|cargo\s+(test|build|check|clippy)|go\s+(test|build|vet)|make\s+(test|check|lint)|bats|tsc|ruff\s+check|shellcheck|uv\s+run\s[^;&|]*pytest)([^-A-Za-z0-9_]|$)/;

export const CLASSIFIER_NOTE =
  "This Bash call ran one of this repository's own verification runners (test, lint, build, or typecheck).";

export const INVALID_LEDGER_REASON =
  "Verification evidence has invalid schema. Use the evidence_log MCP tool (NOT manual file writes). Required: entries[] with type, command, exit_code, output_snippet, timestamp fields.";

/** A quoted span is a mention, not an invocation: `echo "npm test"` runs no test. */
export function blankQuotedSpans(command: string): string {
  return command.replace(/"[^"\n]*"/g, '""').replace(/'[^'\n]*'/g, "''");
}

export function isVerificationCommand(command: string): boolean {
  return RUNNER.test(blankQuotedSpans(command));
}

/**
 * A recent unsatisfied slot, one with no evidence logged after it, outranks a newer
 * verification: overwriting it would let a logged lint run shadow an earlier unlogged failing
 * test run. Once the gate stops enforcing it as stale, a newer verification replaces it, or
 * one forgotten log would switch the gate off for the rest of the session.
 */
export function keepsSlot(previous: Verification | undefined, ledgerMtimeSeconds: number, nowSeconds: number): boolean {
  return (
    previous !== undefined &&
    isSlotRecent(nowSeconds, previous.at) &&
    !ledgerCoversSlot(ledgerMtimeSeconds, previous.at)
  );
}

/** Display only: the Bash tool_response shape is undocumented, so anything else is null. */
export function exitCodeOf(toolResponse: unknown): number | null {
  if (typeof toolResponse !== "object" || toolResponse === null || Array.isArray(toolResponse)) return null;
  const response = toolResponse as Record<string, unknown>;
  const code = response["exitCode"] ?? response["exit_code"];
  return typeof code === "number" ? code : null;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export function unloggedReason({ command, at }: Verification): string {
  const ran = new Date(at * 1000);
  return (
    `You ran \`${command}\` at ${pad2(ran.getHours())}:${pad2(ran.getMinutes())} but logged no evidence after it. ` +
    "Log the real result with evidence_log, including a non-zero exit_code if it failed. " +
    `Example: evidence_log(evidence_type="test", command="${command}", exit_code=0, output_snippet="10 passed")`
  );
}
