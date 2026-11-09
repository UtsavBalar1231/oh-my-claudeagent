import { COMMENT_ATTRIBUTION_HEAD, COMMENT_SLOP_HEAD, KEEP_NOTICE } from "./comments.ts";
import { GUARD_REASONS, REVIEW_REFUSED_REASON, REVIEW_REFUSED_REMEDY } from "./destructive.ts";
import { INVALID_LEDGER_REASON } from "./verification.ts";

const finalTaskOf = (run: string): string => `is the final task of run '${run}'`;
const DROPS_OUT = ", and it stays final: an internal task drops out of the run";
const STAYS_FINAL = ", and it stays final";
const NO_VERDICT = ", and no final verification names it";
const NO_PASSING_VERDICT = ", and no passing final verification names it";

export const stayFinalReason = (id: string, run: string): string => `Task #${id} ${finalTaskOf(run)}${STAYS_FINAL}.`;
export const internalFinalReason = (id: string, run: string): string => `Task #${id} ${finalTaskOf(run)}${DROPS_OUT}.`;
export const noVerdictReason = (id: string, run: string): string =>
  `Task #${id} ${finalTaskOf(run)}${NO_VERDICT}. Record the verdict first: evidence_log(evidence_type="final_verification", command="<what the review covered>", exit_code=<0 for COMPLETE, 1 for INCOMPLETE>, output_snippet="<verdict, and why the run stops here>", task_id="${id}").`;
export const noPassingVerdictReason = (id: string, subject: string, run: string): string =>
  `Task #${id} '${subject}' ${finalTaskOf(run)}${NO_PASSING_VERDICT}. Review the run, then record the verdict: evidence_log(evidence_type="final_verification", command="<what the review covered>", exit_code=0, output_snippet="<verdict, naming any task closed as blocked>", task_id="${id}"). If the review finds a gap, fix it and review again.`;

export type RefusalKind =
  | "guard"
  | "review-refused"
  | "final-kept"
  | "final-unlogged"
  | "completion-held"
  | "verification-unlogged"
  | "ledger-invalid"
  | "comment";

export type Refusal = { kind: RefusalKind; taskId?: string; title: string; remedy?: string; detail?: string };

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const TASK_TAILS = new Map<string, Omit<Refusal, "taskId">>([
  [DROPS_OUT, { kind: "final-kept", title: "stays the run's final task" }],
  [STAYS_FINAL, { kind: "final-kept", title: "stays the run's final task" }],
  [NO_VERDICT, { kind: "final-unlogged", title: "final task has no logged verdict", remedy: "record the verdict first with evidence_log" }],
  [
    NO_PASSING_VERDICT,
    { kind: "completion-held", title: "completion held: no passing verdict names it", remedy: "review the run, then record the verdict with evidence_log" },
  ],
]);
// A run name or subject can hold a quote, so the lazy spans stop at the first tail that follows.
const TASK_REASON = new RegExp(
  `^Task #(\\S+) (?:'[^\\n]*?' )?is the final task of run '[^\\n]*?'(${[...TASK_TAILS.keys()].map(escaped).join("|")})`,
);
const UNLOGGED_REASON = /^You ran `[\s\S]*? at \d{2}:\d{2} but logged no evidence after it\. Log the real result with evidence_log/;

// Where the engine puts a hook's reason: the plugin list is the comma-separated names of every plugin with a
// `tool.check` hook, and a task hook's reason follows `TaskCompleted hook feedback:` on the next line.
const WRAPPER = /^(?:Error: Permission to use \S+ denied by plugins? [^:\n]+: |Error: PreToolUse:\S+ hook error: |TaskCompleted hook feedback:\r?\n)/;

const COMMENT_TITLES: readonly [string, string][] = [
  [COMMENT_SLOP_HEAD, "comment slop"],
  [COMMENT_ATTRIBUTION_HEAD, "AI-attribution or placeholder comment"],
];
const COMMENT_REMEDY = "delete the quoted comment, or rewrite it as the reason the code is the way it is";

function commentDetail(afterHead: string): string | undefined {
  const end = afterHead.indexOf(KEEP_NOTICE);
  return /\("(.*?)"\): /.exec(end < 0 ? afterHead : afterHead.slice(0, end))?.[1];
}

function commentHeadAt(text: string): Refusal | undefined {
  for (const [head, title] of COMMENT_TITLES) {
    if (!text.startsWith(head)) continue;
    const detail = commentDetail(text.slice(head.length));
    return { kind: "comment", title, remedy: COMMENT_REMEDY, ...(detail !== undefined && { detail }) };
  }
  return undefined;
}

function headAt(text: string): Refusal | undefined {
  for (const { reason, title, remedy } of GUARD_REASONS) {
    if (text.startsWith(reason)) return { kind: "guard", title, remedy };
  }
  if (text.startsWith(REVIEW_REFUSED_REASON)) {
    return { kind: "review-refused", title: "the user refused this command", remedy: REVIEW_REFUSED_REMEDY };
  }
  const comment = commentHeadAt(text);
  if (comment !== undefined) return comment;
  if (text.startsWith(INVALID_LEDGER_REASON)) {
    return { kind: "ledger-invalid", title: "evidence ledger invalid", remedy: "log with the evidence_log tool, not manual file writes" };
  }
  const [, taskId, taskTail] = TASK_REASON.exec(text) ?? [];
  const tail = TASK_TAILS.get(taskTail ?? "");
  if (taskId !== undefined && tail !== undefined) return { ...tail, taskId };
  if (UNLOGGED_REASON.test(text)) {
    return {
      kind: "verification-unlogged",
      title: "completion held: a verification ran and is not logged",
      remedy: "log the real result with evidence_log, including a non-zero exit_code if it failed",
    };
  }
  return undefined;
}

/**
 * The refusal OMCA wrote that `text` carries, or undefined. A head counts only right after one of
 * the engine's wrappers, so a failing command whose output quotes a reason is not a refusal. The
 * comment check's heads also count right after a bare `Error: `, the form Write and Edit use. When
 * another hook's text sits between the wrapper and OMCA's, the first head at a line start counts.
 */
export function refusalOf(text: string): Refusal | undefined {
  const wrapper = WRAPPER.exec(text);
  if (wrapper === null) return text.startsWith("Error: ") ? commentHeadAt(text.slice("Error: ".length)) : undefined;
  let offset = wrapper[0].length;
  for (;;) {
    const found = headAt(text.slice(offset));
    if (found !== undefined) return found;
    const newline = text.indexOf("\n", offset);
    if (newline < 0) return undefined;
    offset = newline + 1;
    offset += WRAPPER.exec(text.slice(offset))?.[0].length ?? 0;
  }
}
