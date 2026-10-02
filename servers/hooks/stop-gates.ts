import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { asRegistry, resolveBoundPlan } from "../../src/core/boulder.ts";
import { checkboxStates, planIsComplete } from "../../src/core/checkboxes.ts";
import { addedLines, type Candidate, hasCompletionClaim, hasStubMarker, isStubFinding } from "../../src/core/drift.ts";
import { isHookDisabled } from "../../src/core/kill-switch.ts";
import { hasPassingFinalVerification } from "../../src/core/next-actions.ts";
import { FRESH_BACKOFF, spendBlock, type StopGate, stepBackoff } from "../../src/core/stop-ledger.ts";
import type { Context, Handler, Payload } from "./registry.ts";
import type { Session } from "./session-state.ts";
import { ledgerMtimeSeconds, ledgerPath, seconds } from "./status-file.ts";

type Json = Readonly<Record<string, unknown>>;
type Parsed = { kind: "absent" } | { kind: "corrupt" } | { kind: "ok"; data: unknown };
type Plan = { name: string; path: string; boundAt: unknown; bytes: Buffer; content: string };
type Turn = { payload: Payload; context: Context; registry: Parsed; transcript: () => Promise<(Json | undefined)[]> };
type Gate = (turn: Turn) => Promise<string | undefined>;

const COMPACTION_FRESH_SECONDS = 60;
// A binding this old with no evidence logged since looks abandoned rather than worked.
const STALE_BINDING_SECONDS = 86_400;
// About 1 ms of scan per file; a larger change set is machine-generated.
const MAX_CHANGED_FILES = 500;
const TERMINAL_TASK_STATUS = /^(completed?|failed|error|killed|cancell?ed|timed?_?out|done)$/;
const PAUSE_REQUEST = /\b(pause|stop here|thats enough|later|hold off|take a break)\b/;
const BLOCKING_QUESTIONS = /^[^\S\n]*#{1,6}[^\S\n]*BLOCKING QUESTIONS/im;
const NEXT_TASK = /^- \[ \] \d+\.[^\S\n]*(.*)$/m;
const GIT_DIFF = ["-c", "diff.mnemonicPrefix=false", "-c", "diff.noprefix=false", "-c", "core.quotePath=false", "diff", "--no-ext-diff", "HEAD"];

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const field = (value: unknown, key: string): unknown => (isObject(value) ? value[key] : undefined);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const withoutTrailingNewlines = (value: string): string => value.replace(/\n+$/, "");
const nonEmptyLines = (value: string): string[] => value.split("\n").filter(Boolean);
const registryPath = (root: string): string => join(root, ".omca", "state", "boulder.json");

function parseFile(path: string, isCorrupt: (data: unknown) => boolean): Parsed {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (field(error, "code") === "ENOENT") return { kind: "absent" };
    return { kind: "corrupt" };
  }
  try {
    const data: unknown = JSON.parse(raw);
    return isCorrupt(data) ? { kind: "corrupt" } : { kind: "ok", data };
  } catch {
    return { kind: "corrupt" };
  }
}

function boundPlan({ registry, payload, context }: Turn): Plan | undefined {
  if (registry.kind !== "ok" || typeof payload.session_id !== "string") return undefined;
  const plan = resolveBoundPlan(registry.data, payload.session_id, true);
  if (!("plan_name" in plan)) return undefined;
  const boundAt = asRegistry(registry.data).bindings[payload.session_id]?.bound_at;
  try {
    const bytes = readFileSync(resolve(context.root, plan.active_plan));
    return { name: plan.plan_name, path: plan.active_plan, boundAt, bytes, content: bytes.toString("utf8") };
  } catch {
    return undefined;
  }
}

const spend = (session: Session | undefined, gate: StopGate): boolean => session !== undefined && spendBlock((session.stopBlocks ??= new Map()), gate);

const refund = (session: Session | undefined, gate: StopGate): void => {
  session?.stopBlocks?.delete(gate);
};

async function readTranscript(path: unknown): Promise<(Json | undefined)[]> {
  if (typeof path !== "string" || path === "") return [];
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        const entry: unknown = JSON.parse(line);
        return isObject(entry) ? entry : undefined;
      } catch {
        return undefined;
      }
    });
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

function lastText(entries: readonly (Json | undefined)[], role: string): string {
  for (const entry of entries.toReversed()) {
    const found = withoutTrailingNewlines(messageText(entry, role));
    if (found !== "" && found !== "null") return found;
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
function askedUserThisTurn(entries: readonly (Json | undefined)[]): boolean {
  for (const entry of entries.toReversed()) {
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
// turn is paused until the work wakes it, not stalled mid-plan.
const hasLiveBackgroundTask = (tasks: unknown): boolean =>
  Array.isArray(tasks) && tasks.some((task) => isObject(task) && !TERMINAL_TASK_STATUS.test(String(task.status ?? "running").toLowerCase()));

const isFreshCompaction = (session: Session | undefined, now: number): boolean =>
  session?.compactedAt !== undefined && now - session.compactedAt < COMPACTION_FRESH_SECONDS * 1000;

function isStaleBinding(root: string, boundAt: unknown, nowSeconds: number): boolean {
  if (typeof boundAt !== "number" || !Number.isInteger(boundAt) || boundAt < 0) return false;
  return nowSeconds - boundAt > STALE_BINDING_SECONDS && ledgerMtimeSeconds(root) <= boundAt;
}

const planContinuation: Gate = async (turn) => {
  const { payload, context, registry } = turn;
  const { root, session } = context;
  if (registry.kind === "corrupt") {
    if (!spend(session, "plan-continuation")) return undefined;
    return `[PLAN CONTINUATION] ${registryPath(root)} is not valid JSON, so this session's plan state cannot be resolved and plan-scoped enforcement is off. Repair or delete the file (boulder_write rewrites it), then stop again. Set OMCA_DISABLED_HOOKS=plan-continuation to bypass.`;
  }
  const plan = boundPlan(turn);
  if (plan === undefined) return undefined;
  const unchecked = checkboxStates(plan.content).filter((state) => state === " ").length;
  if (unchecked === 0) return undefined;
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
  const step = stepBackoff(session.planBackoff ?? FRESH_BACKOFF, unchecked, nowSeconds);
  if (step.isWindowReset) refund(session, "plan-continuation");
  session.planBackoff = step.state;
  if (!step.isBlocking || !spend(session, "plan-continuation")) return undefined;
  const next = NEXT_TASK.exec(plan.content)?.[1] ?? "";
  return `[PLAN CONTINUATION] The bound plan '${plan.name}' still has ${unchecked} unchecked tasks (next: ${next}). Continue with the next task. If its work is already done and reviewed, flip its checkbox. If it cannot proceed without the user, record why with notepad_write and ask the user; a turn that asks the user is not blocked.`;
};

const finalVerification: Gate = async (turn) => {
  const { root, session } = turn.context;
  if (turn.registry.kind === "corrupt") {
    console.error(`omca: final-verification: ${registryPath(root)} is not valid JSON, so no plan resolves and this gate is not enforcing. Repair or delete the file.`);
    return undefined;
  }
  const plan = boundPlan(turn);
  if (plan === undefined || !planIsComplete(plan.content)) return undefined;
  const ledger = parseFile(ledgerPath(root), (data) => !Array.isArray(field(data, "entries")));
  if (ledger.kind === "corrupt") {
    return spend(session, "final-verification") ? `[FINAL VERIFICATION] Evidence file corrupt. Repair ${ledgerPath(root)} before stopping.` : undefined;
  }
  const sha256 = createHash("sha256").update(plan.bytes).digest("hex");
  if (ledger.kind === "ok" && hasPassingFinalVerification(ledger.data, sha256)) {
    refund(session, "final-verification");
    return undefined;
  }
  if (!spend(session, "final-verification")) return undefined;
  return `[FINAL VERIFICATION] Every task in plan '${plan.path}' is checked, but no final_verification evidence matches its current contents. Record the verdict of the plan's completeness review, running the review first if it has not run: evidence_log(evidence_type="final_verification", command="<what the review covered>", exit_code=<0 for COMPLETE, 1 for INCOMPLETE>, output_snippet="<verdict>", plan_sha256="${sha256}"). An INCOMPLETE verdict means fixing the gap and reviewing again. Set OMCA_DISABLED_HOOKS=final-verification to bypass.`;
};

async function git(root: string, args: readonly string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, stdout };
}

async function untrackedLines(root: string, files: readonly string[]): Promise<Candidate[]> {
  const perFile = await Promise.all(
    files.map(async (file) => {
      const path = join(root, file);
      if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return [];
      const bytes = await readFile(path);
      if (bytes.includes(0)) return [];
      return bytes
        .toString("utf8")
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
  let entries: Promise<(Json | undefined)[]> | undefined;
  const turn: Turn = {
    payload,
    context,
    registry: parseFile(registryPath(context.root), (data) => data === null || data === false),
    transcript: () => (entries ??= readTranscript(payload.transcript_path)),
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
