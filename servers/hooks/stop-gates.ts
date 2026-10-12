import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { allTasksDone, type PlanTask, planTasks } from "../../src/core/checkboxes.ts";
import { addedLines, type Candidate, hasCompletionClaim, hasStubMarker, isStubFinding } from "../../src/core/drift.ts";
import { entriesOf, readLedger } from "../../src/core/evidence.ts";
import { isHookDisabled } from "../../src/core/kill-switch.ts";
import { hasPassingFinalVerification } from "../../src/core/next-actions.ts";
import { FRESH_BACKOFF, spendBlock, type StopGate, stepBackoff } from "../../src/core/stop-ledger.ts";
import { field, isRecord, text } from "../../src/core/tool-input.ts";
import { errorCode, isMissing } from "../io.ts";
import type { Context, Handler, Payload } from "./registry.ts";
import type { Session } from "./session-state.ts";
import { ledgerMtimeSeconds, ledgerPath, readBoundPlan, readRegistry, type RegistryRead, registryPath, seconds } from "./status-file.ts";

type Json = Readonly<Record<string, unknown>>;
type LedgerFile = { kind: "absent" } | { kind: "corrupt" } | { kind: "unreadable"; code: string } | { kind: "ok"; document: Record<string, unknown> };
type Plan = { name: string; path: string; boundAt: unknown; bytes: Buffer; tasks: PlanTask[] };
type Entries = Iterable<Json | undefined>;
type Turn = { payload: Payload; context: Context; registry: RegistryRead; transcript: () => Promise<Entries>; plan: () => Plan | undefined };
type Gate = (turn: Turn) => Promise<string | undefined>;

const COMPACTION_FRESH_SECONDS = 60;
// The gates read only the current turn's records, which sit at the end of the transcript.
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
// A binding this old with no evidence logged since looks abandoned rather than worked.
const STALE_BINDING_SECONDS = 86_400;
// About 1 ms of scan per file; a larger change set is machine-generated.
const MAX_CHANGED_FILES = 500;
// Past this a file is generated or data, not worth a read at every Stop.
const MAX_UNTRACKED_BYTES = 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;
const TERMINAL_TASK_STATUS = /^(completed?|failed|error|killed|cancell?ed|timed?_?out|done)$/;
// A pause is a whole sentence or clause ("lets pause here for now.", "ok, stop here"), so a request
// that only uses one of the words ("do task 2 later", "pause the music") is not one.
const PAUSE_REQUEST =
  /(?:^|[.!?,;]\s*)(?:(?:ok(?:ay)?|please|lets|can we|we can|you can|well)\s+)*(?:pause(?: here| now| for now)?|stop(?: here| now| for now)|thats enough(?: for now| for today)?|hold off(?: for now)?|take a break|(?:continue|resume|pick (?:this|it) up|finish (?:this|it|the rest)) (?:later|tomorrow)|later)(?: for now)?(?:\s+(?:please|thanks))?\s*(?=[.!?,;]|$)/m;
const BLOCKING_QUESTIONS = /^[^\S\n]*#{1,6}[^\S\n]*BLOCKING QUESTIONS/im;
const GIT_DIFF = ["-c", "diff.mnemonicPrefix=false", "-c", "diff.noprefix=false", "-c", "core.quotePath=false", "diff", "--no-ext-diff", "HEAD"];

const withoutTrailingNewlines = (value: string): string => value.replace(/\n+$/, "");
const nonEmptyLines = (value: string): string[] => value.split("\n").filter(Boolean);

function readLedgerFile(path: string): LedgerFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return { kind: "absent" };
    return { kind: "unreadable", code: errorCode(error) ?? String(error) };
  }
  const read = readLedger(raw);
  return read.kind === "ok" && entriesOf(read.document) !== undefined ? { kind: "ok", document: read.document } : { kind: "corrupt" };
}

function boundPlan(payload: Payload, root: string, registry: RegistryRead): Plan | undefined {
  if (typeof payload.session_id !== "string") return undefined;
  const read = readBoundPlan(root, payload.session_id, registry);
  if (read.kind === "unreadable" && registry.kind === "ok") console.error(`omca: Stop gates could not read the plan ${read.path} (${read.code})`);
  if (read.kind !== "ok" || read.file === undefined) return undefined;
  return { name: read.name, path: read.path, boundAt: read.boundAt, bytes: read.file.bytes, tasks: planTasks(read.file.content) };
}

const spend = (session: Session | undefined, gate: StopGate): boolean => session !== undefined && spendBlock((session.stopBlocks ??= new Map()), gate);

const refund = (session: Session | undefined, gate: StopGate): void => {
  session?.stopBlocks?.delete(gate);
};

const settlePlan = (session: Session | undefined): void => {
  refund(session, "plan-continuation");
  if (session !== undefined) delete session.planBackoff;
};

async function readTail(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } finally {
    await handle.close();
  }
}

function parseEntry(line: string): Json | undefined {
  try {
    const entry: unknown = JSON.parse(line);
    return isRecord(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

// Newest first, parsed on demand and kept, so each reader parses only as far back as its own scan goes.
function newestFirst(raw: string): Entries {
  const parsed: (Json | undefined)[] = [];
  let end = raw.length;
  const parseOlder = (): boolean => {
    while (end > 0) {
      const start = raw.lastIndexOf("\n", end - 1) + 1;
      const line = raw.slice(start, end);
      end = start - 1;
      if (line.trim() === "") continue;
      parsed.push(parseEntry(line));
      return true;
    }
    return false;
  };
  return {
    *[Symbol.iterator]() {
      for (let index = 0; index < parsed.length || parseOlder(); index++) yield parsed[index];
    },
  };
}

async function readTranscript(path: unknown): Promise<Entries> {
  if (typeof path !== "string" || path === "") return [];
  let raw: string;
  try {
    raw = await readTail(path);
  } catch (error) {
    if (!isMissing(error)) console.error(`omca: Stop gates could not read the transcript ${path}:`, error);
    return [];
  }
  return newestFirst(raw);
}

function messageText(entry: Json | undefined, role: string): string {
  if (entry?.type !== role || field(entry.message, "role") !== role) return "";
  const content = field(entry.message, "content");
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => field(block, "type") === "text")
    .map((block) => text(field(block, "text")))
    .join("\n");
}

function lastText(entries: Entries, role: string): string {
  for (const entry of entries) {
    const found = withoutTrailingNewlines(messageText(entry, role));
    if (found !== "") return found;
  }
  return "";
}

// The payload's message is authoritative: the transcript may not hold the turn's final message yet.
async function assistantText(turn: Turn): Promise<string> {
  const message = withoutTrailingNewlines(text(turn.payload.last_assistant_message));
  return message !== "" && message !== "null" ? message : lastText(await turn.transcript(), "assistant");
}

// A tool call leaves no payload field at Stop, so the transcript is the only witness. The scan
// stops at the first real user prompt, so a question answered turns ago grants nothing, and an
// unreadable record yields no signal.
function askedUserThisTurn(entries: Entries): boolean {
  for (const entry of entries) {
    if (entry === undefined) return false;
    const content = field(entry.message, "content");
    const blocks = Array.isArray(content) ? content : [];
    if (entry.type === "assistant" && blocks.some((block) => field(block, "type") === "tool_use" && field(block, "name") === "AskUserQuestion")) {
      return true;
    }
    if (entry.type === "user" && field(entry.message, "role") === "user" && !blocks.some((block) => field(block, "type") === "tool_result")) {
      return false;
    }
  }
  return false;
}

// A spawned subagent is a background task, so every parallel wave ends a turn this way; the
// turn is paused until the work wakes it, not stalled mid-plan. A background shell (a dev
// server, a watcher) runs on its own and wakes nothing, so it does not count.
const hasLiveBackgroundTask = (tasks: unknown): boolean =>
  Array.isArray(tasks) &&
  tasks.some((task) => isRecord(task) && task.type !== "shell" && !TERMINAL_TASK_STATUS.test(String(task.status ?? "running").toLowerCase()));

const isFreshCompaction = (session: Session | undefined, now: number): boolean =>
  session?.compactedAt !== undefined && now - session.compactedAt < COMPACTION_FRESH_SECONDS * 1000;

function isStaleBinding(root: string, boundAt: unknown, nowSeconds: number): boolean {
  if (typeof boundAt !== "number" || !Number.isInteger(boundAt) || boundAt < 0) return false;
  return nowSeconds - boundAt > STALE_BINDING_SECONDS && ledgerMtimeSeconds(root) <= boundAt;
}

const planContinuation: Gate = async (turn) => {
  const { payload, context, registry } = turn;
  const { root, session } = context;
  if (registry.kind === "corrupt" || registry.kind === "unreadable") {
    if (!spend(session, "plan-continuation")) return undefined;
    const problem = registry.kind === "corrupt" ? "is not valid JSON" : `cannot be read (${registry.code})`;
    return `[PLAN CONTINUATION] ${registryPath(root)} ${problem}, so this session's plan state cannot be resolved and plan-scoped enforcement is off. Repair or delete the file, then stop again. Set OMCA_DISABLED_HOOKS=plan-continuation to bypass.`;
  }
  const plan = turn.plan();
  const open = plan === undefined ? [] : plan.tasks.filter((task) => !task.checked);
  const unchecked = open.length;
  if (plan === undefined || unchecked === 0) {
    settlePlan(session);
    return undefined;
  }
  if (session?.planBackoff !== undefined && session.planBackoff.plan !== plan.name) settlePlan(session);
  if (hasLiveBackgroundTask(payload.background_tasks)) {
    refund(session, "plan-continuation");
    return undefined;
  }
  const nowSeconds = seconds(context.now);
  if (PAUSE_REQUEST.test(lastText(await turn.transcript(), "user").toLowerCase().replaceAll("'", ""))) return undefined;
  if (isFreshCompaction(session, context.now)) return undefined;
  if (isStaleBinding(root, plan.boundAt, nowSeconds)) return undefined;
  if (BLOCKING_QUESTIONS.test(await assistantText(turn)) || askedUserThisTurn(await turn.transcript())) return undefined;
  if (session === undefined) return undefined;
  const step = stepBackoff(session.planBackoff?.backoff ?? FRESH_BACKOFF, unchecked, nowSeconds);
  if (step.isWindowReset) refund(session, "plan-continuation");
  session.planBackoff = { plan: plan.name, backoff: step.state };
  if (!step.isBlocking || !spend(session, "plan-continuation")) return undefined;
  const next = open[0]?.label ?? "";
  return `[PLAN CONTINUATION] The bound plan '${plan.name}' still has ${unchecked} unchecked ${unchecked === 1 ? "task" : "tasks"} (next: ${next}). Continue with the next task. If its work is already done and reviewed, flip its checkbox. If it cannot proceed without the user, record why with notepad_write and ask the user; a turn that asks the user is not blocked.`;
};

const finalVerification: Gate = async (turn) => {
  const { root, session } = turn.context;
  if (turn.registry.kind === "corrupt" || turn.registry.kind === "unreadable") {
    const problem = turn.registry.kind === "corrupt" ? "is not valid JSON" : `cannot be read (${turn.registry.code})`;
    console.error(`omca: final-verification: ${registryPath(root)} ${problem}, so no plan resolves and this gate is not enforcing. Repair or delete the file.`);
    return undefined;
  }
  const plan = turn.plan();
  if (plan === undefined || !allTasksDone({ done: plan.tasks.filter((task) => task.checked).length, total: plan.tasks.length })) return undefined;
  const ledger = readLedgerFile(ledgerPath(root));
  if (ledger.kind === "corrupt") {
    return spend(session, "final-verification") ? `[FINAL VERIFICATION] Evidence file corrupt. Repair ${ledgerPath(root)} before stopping.` : undefined;
  }
  if (ledger.kind === "unreadable") {
    return spend(session, "final-verification") ? `[FINAL VERIFICATION] Evidence file unreadable (${ledger.code}). Fix ${ledgerPath(root)} before stopping.` : undefined;
  }
  const sha256 = createHash("sha256").update(plan.bytes).digest("hex");
  if (ledger.kind === "ok" && hasPassingFinalVerification(ledger.document, sha256)) {
    refund(session, "final-verification");
    return undefined;
  }
  if (!spend(session, "final-verification")) return undefined;
  return `[FINAL VERIFICATION] Every task in plan '${plan.path}' is checked, but no final_verification evidence matches its current contents. Record the verdict of the plan's completeness review, running the review first if it has not run: evidence_log(evidence_type="final_verification", command="<what the review covered>", exit_code=<0 for COMPLETE, 1 for INCOMPLETE>, output_snippet="<verdict>", plan_sha256="${sha256}"). An INCOMPLETE verdict means fixing the gap and reviewing again. Set OMCA_DISABLED_HOOKS=final-verification to bypass.`;
};

async function git(root: string, args: readonly string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, stdout };
}

async function untrackedLines(root: string, files: readonly string[]): Promise<Candidate[]> {
  const perFile = await Promise.all(
    files.map(async (file) => {
      const path = join(root, file);
      const stat = statSync(path, { throwIfNoEntry: false });
      if (!stat?.isFile() || stat.size > MAX_UNTRACKED_BYTES) return [];
      const content = Bun.file(path);
      if ((await content.slice(0, BINARY_SNIFF_BYTES).bytes()).includes(0)) return [];
      return (await content.text())
        .split("\n")
        .flatMap((line, index) => (hasStubMarker(line) ? [{ file, line: index + 1, text: line }] : []));
    }),
  );
  return perFile.flat();
}

const driftGuard: Gate = async (turn) => {
  const { root, session } = turn.context;
  const message = await assistantText(turn);
  if (!hasCompletionClaim(message)) return undefined;
  if ((await git(root, ["rev-parse", "HEAD"])).code !== 0) return undefined;
  const [changed, untracked] = await Promise.all([
    git(root, [...GIT_DIFF, "--name-only"]),
    git(root, ["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard"]),
  ]);
  const untrackedFiles = nonEmptyLines(untracked.stdout);
  const fileCount = nonEmptyLines(changed.stdout).length + untrackedFiles.length;
  if (fileCount > MAX_CHANGED_FILES) {
    console.error(`omca: drift-guard: ${fileCount} changed files exceeds the ${MAX_CHANGED_FILES}-file scan ceiling, so the stub scan is skipped this Stop.`);
    return undefined;
  }
  const diff = await git(root, [...GIT_DIFF, "--unified=0"]);
  const findings = [...addedLines(diff.stdout), ...(await untrackedLines(root, untrackedFiles))].filter(isStubFinding);
  if (findings.length === 0) {
    refund(session, "drift-guard");
    return undefined;
  }
  if (!spend(session, "drift-guard")) return undefined;
  const listed = findings.map(({ file, line, text }) => `${file}:${line}  ${text.replace(/^\t+|\t+$/g, "")}\n`).join("");
  return `[DRIFT GUARD] Completion claimed but stub markers remain on added/untracked lines:\n${listed}\nResolve the stubs before claiming done, or stop claiming completion. Set OMCA_DISABLED_HOOKS=drift-guard to bypass.`;
};

const GATES: readonly (readonly [StopGate, Gate])[] = [
  ["plan-continuation", planContinuation],
  ["final-verification", finalVerification],
  ["drift-guard", driftGuard],
];

// A `decision: "block"` from a Stop hook continues the turn too, but the client files it as a
// hook error. `additionalContext` keeps the turn going as feedback under the same loop limits.
export const handle: Handler = async (payload, context) => {
  const disabled = process.env.OMCA_DISABLED_HOOKS;
  if (payload.stop_hook_active === "true" || isHookDisabled(disabled, "stop-gates")) return undefined;
  const registry = readRegistry(context.root);
  let entries: Promise<Entries> | undefined;
  let plan: { value: Plan | undefined } | undefined;
  const turn: Turn = {
    payload,
    context,
    registry,
    transcript: () => (entries ??= readTranscript(payload.transcript_path)),
    plan: () => (plan ??= { value: boundPlan(payload, context.root, registry) }).value,
  };
  for (const [name, gate] of GATES) {
    if (isHookDisabled(disabled, name)) continue;
    try {
      const reason = await gate(turn);
      if (reason !== undefined) return { hookSpecificOutput: { hookEventName: "Stop", additionalContext: reason } };
    } catch (error) {
      console.error(`omca: the ${name} Stop gate failed:`, error);
    }
  }
  return undefined;
};
