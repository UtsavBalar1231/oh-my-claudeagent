import { statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { addedLines, type Candidate, hasCompletionClaim, hasStubMarker, isStubFinding } from "../../src/core/drift.ts";
import { isHookDisabled } from "../../src/core/kill-switch.ts";
import { FRESH_BACKOFF, spendBlock, type StopGate, stepBackoff } from "../../src/core/stop-ledger.ts";
import { field, isRecord, text } from "../../src/core/tool-input.ts";
import { isMissing } from "../io.ts";
import type { Context, Handler, Payload } from "./registry.ts";
import type { Session } from "./session-state.ts";
import { readOpenRun, seconds } from "./status-file.ts";

type Json = Readonly<Record<string, unknown>>;
type Entries = Iterable<Json | undefined>;
type Turn = { payload: Payload; context: Context; transcript: () => Promise<Entries> };
type Gate = (turn: Turn) => Promise<string | undefined>;

const COMPACTION_FRESH_SECONDS = 60;
// The gates read only the current turn's records, which sit at the end of the transcript.
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
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

const spend = (session: Session | undefined, gate: StopGate): boolean => session !== undefined && spendBlock((session.stopBlocks ??= new Map()), gate);

const refund = (session: Session | undefined, gate: StopGate): void => {
  session?.stopBlocks?.delete(gate);
};

const settleRun = (session: Session): void => {
  refund(session, "task-continuation");
  delete session.runBackoff;
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
// turn is paused until the work wakes it, not stalled mid-run. A background shell (a dev
// server, a watcher) runs on its own and wakes nothing, so it does not count.
const hasLiveBackgroundTask = (tasks: unknown): boolean =>
  Array.isArray(tasks) &&
  tasks.some((task) => isRecord(task) && task.type !== "shell" && !TERMINAL_TASK_STATUS.test(String(task.status ?? "running").toLowerCase()));

const isFreshCompaction = (session: Session | undefined, now: number): boolean =>
  session?.compactedAt !== undefined && now - session.compactedAt < COMPACTION_FRESH_SECONDS * 1000;

// A list outlives its session, so only a session that touched a task answers for the run: one that
// starts beside an unfinished list picks the run up by touching it.
const taskContinuation: Gate = async (turn) => {
  const { payload, context } = turn;
  const { root, session } = context;
  if (session?.hasTouchedTask !== true) return undefined;
  const run = readOpenRun(root, session.id);
  if (run === undefined) {
    settleRun(session);
    return undefined;
  }
  if (session.runBackoff !== undefined && session.runBackoff.run !== run.name) settleRun(session);
  if (hasLiveBackgroundTask(payload.background_tasks)) {
    refund(session, "task-continuation");
    return undefined;
  }
  if (PAUSE_REQUEST.test(lastText(await turn.transcript(), "user").toLowerCase().replaceAll("'", ""))) return undefined;
  if (isFreshCompaction(session, context.now)) return undefined;
  if (BLOCKING_QUESTIONS.test(await assistantText(turn)) || askedUserThisTurn(await turn.transcript())) return undefined;
  const count = run.open.length;
  const step = stepBackoff(session.runBackoff?.backoff ?? FRESH_BACKOFF, count, seconds(context.now));
  if (step.isWindowReset) refund(session, "task-continuation");
  session.runBackoff = { run: run.name, backoff: step.state };
  if (!step.isBlocking || !spend(session, "task-continuation")) return undefined;
  return `[TASK CONTINUATION] Run '${run.name}' still has ${count} open ${count === 1 ? "task" : "tasks"} (next: #${run.next.id} ${run.next.subject}). Continue with the next task. If its work is already done and reviewed, complete it with TaskUpdate. If it cannot proceed, close it as blocked with TaskUpdate metadata {"blocked": "<why>"}, or ask the user; a turn that asks the user is not blocked.`;
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
  ["task-continuation", taskContinuation],
  ["drift-guard", driftGuard],
];

// A `decision: "block"` from a Stop hook continues the turn too, but the client files it as a
// hook error. `additionalContext` keeps the turn going as feedback under the same loop limits.
export const handle: Handler = async (payload, context) => {
  const disabled = process.env.OMCA_DISABLED_HOOKS;
  if (payload.stop_hook_active === "true" || isHookDisabled(disabled, "stop-gates")) return undefined;
  let entries: Promise<Entries> | undefined;
  const turn: Turn = { payload, context, transcript: () => (entries ??= readTranscript(payload.transcript_path)) };
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
