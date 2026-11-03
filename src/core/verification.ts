import { isSlotRecent, ledgerCoversSlot } from "./evidence.ts";
import { isRecord } from "./tool-input.ts";
import { two } from "./ui-kit.ts";

export type Verification = { command: string; at: number; exit_code: number | null };

// A runner missing from this list records nothing and the gate stays silent, so a miss is a
// false negative, never a false block; the list grows only when a real runner goes unrecorded.
// `test` and `lint` take a suffix because the suffix narrows the check; `build` and `fmt`
// cannot, since build-and-deploy ships and fmt rewrites. The separator anchor keeps a flag
// value such as `--include=pytest` from reading as an invocation. A Windows shim name
// (`npm.cmd`, `bun.exe`) is the same runner.
const EXT = String.raw`(?:\.(?:cmd|exe))?`;
const RUNNER = new RegExp(
  String.raw`(^|[;&|(])\s*(just${EXT}\s+((test|lint)(-[A-Za-z0-9_]+)*|ci|fmt-check|typecheck|build|validate|check)|(npm|pnpm|yarn|bun)${EXT}\s+(test|run\s+(test|lint|build))|pytest${EXT}|cargo${EXT}\s+(test|build|check|clippy)|go${EXT}\s+(test|build|vet)|make${EXT}\s+(test|check|lint)|bats${EXT}|tsc${EXT}|ruff${EXT}\s+check|shellcheck${EXT}|uv${EXT}\s+run\s[^;&|]*pytest)([^-A-Za-z0-9_]|$)`,
);

export const classifierNote = (tool: string): string =>
  `This ${tool} call ran one of this repository's own verification runners (test, lint, build, or typecheck).`;

export const INVALID_LEDGER_REASON =
  "Verification evidence has invalid schema. Use the evidence_log MCP tool (NOT manual file writes). Required: entries[] with type, command, exit_code, output_snippet, timestamp fields.";

/** A quoted span is a mention, not an invocation: `echo "npm test"` runs no test. */
export function blankQuotedSpans(command: string): string {
  return command.replace(/"[^"\n]*"/g, '""').replace(/'[^'\n]*'/g, "''");
}

export function isVerificationCommand(command: string): boolean {
  return RUNNER.test(blankQuotedSpans(command));
}

// The block at task completion quotes the command twice, so a heredoc recorded whole costs the
// model thousands of tokens on every block, and the band and its prompt button quote it too.
const QUOTED_COMMAND_CHARS = 200;

/** The line of a command that ran the check, cut to a length the surfaces can quote back. */
export function quotableCommand(command: string): string {
  const lines = command.split(/\r?\n/);
  const line = (lines.find(isVerificationCommand) ?? lines[0] ?? "").trim();
  const quoted = line.slice(0, QUOTED_COMMAND_CHARS);
  return quoted === command.trim() ? quoted : `${quoted}…`;
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
  if (!isRecord(toolResponse)) return null;
  const code = toolResponse["exitCode"] ?? toolResponse["exit_code"];
  return typeof code === "number" ? code : null;
}

export function unloggedReason({ command, at }: Verification): string {
  const ran = new Date(at * 1000);
  return (
    `You ran \`${command}\` at ${two(ran.getHours())}:${two(ran.getMinutes())} but logged no evidence after it. ` +
    "Log the real result with evidence_log, including a non-zero exit_code if it failed. " +
    `Example: evidence_log(evidence_type="test", command="${command}", exit_code=0, output_snippet="10 passed")`
  );
}
