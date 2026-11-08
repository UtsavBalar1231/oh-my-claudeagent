import { dirname, join } from "node:path";
import { entriesOf, EVIDENCE_TYPES, type EvidenceType, readLedger } from "../../src/core/evidence.ts";
import { STATE_VERSION } from "../../src/core/state-version.ts";
import { isRecord } from "../../src/core/tool-input.ts";
import { latestSessionId, touchSession } from "../hooks/session-state.ts";
import { ledgerPath, readTaskList, writeStatus } from "../hooks/status-file.ts";
import { ensureStateDir, readOrNull, withLock, writeFileAtomic } from "../io.ts";
import type { Tool } from "../omca.ts";
import { workingTreeStamp } from "../tree-stamp.ts";
import { argReader, isoTimestamp, rootOf, stringArg, WORKING_DIRECTORY } from "./args.ts";

export const SNIPPET_MAX_CHARS = 2000;
export const COMMAND_MAX_CHARS = 2000;
export const VERIFIED_BY_MAX_CHARS = 200;
export const TASK_ID_MAX_CHARS = 200;
const DEFAULT_READ_ENTRIES = 20;
// A full read is many 2,000-character snippets; 100,000 holds about 50, well under the client's 500,000 ceiling.
const EVIDENCE_MAX_RESULT_CHARS = 100_000;
// The mod reads the ledger through $.fs.read, which fails past 4 MiB.
const ROTATE_BYTES = 1024 * 1024;
const ROTATE_ENTRIES = 1000;
export const KEEP_ENTRIES = 500;

type Ledger = { document: Record<string, unknown>; entries: unknown[] };

export type EvidenceEntry = {
  type: EvidenceType;
  command: string;
  exit_code: number;
  output_snippet: string;
  timestamp: string;
  verified_by?: string;
  task_id?: string;
  tree?: string;
  record_id?: string;
  [key: string]: unknown;
};

// The ledger is an append-only audit trail, so a file that does not parse is refused rather than replaced.
function parseLedger(path: string, text: string): Ledger {
  const read = readLedger(text);
  if (read.kind === "refused") {
    const what = read.code === "version" ? `${path}: ${read.reason}` : `${path} is not an evidence ledger ({"entries": [...]})`;
    throw new Error(`${what}; move it aside to keep logging evidence`);
  }
  return { document: read.document, entries: entriesOf(read.document) ?? [] };
}

function readLedgerFile(path: string): Ledger {
  const text = readOrNull(path);
  return text === null ? { document: {}, entries: [] } : parseLedger(path, text);
}

const capped = (value: string, max: number): string => (value.length > max ? Array.from(value).slice(0, max).join("") : value);

const writeLedger = (path: string, { document, entries }: Ledger): void =>
  writeFileAtomic(path, `${JSON.stringify({ version: STATE_VERSION, ...document, entries }, null, 2)}\n`);

export async function appendEvidence(root: string, entry: EvidenceEntry, beforeWrite?: () => Promise<void>): Promise<number> {
  const path = ledgerPath(root);
  return withLock(`${path}.lock`, async () => {
    if (beforeWrite !== undefined) await beforeWrite();
    const ledger = readLedgerFile(path);
    if (entry.record_id !== undefined && ledger.entries.some((existing) => isRecord(existing) && existing.record_id === entry.record_id)) return ledger.entries.length;
    ledger.entries.push(entry);
    writeLedger(path, ledger);
    return ledger.entries.length;
  });
}

function updateStatus(root: string): void {
  const sessionId = latestSessionId();
  if (sessionId === undefined) return;
  try {
    writeStatus(root, touchSession(sessionId), Date.now());
  } catch (error) {
    console.error(`omca: evidence was logged but the status file of session ${sessionId} was not updated:`, error);
  }
}

/** The run and list of the final task a verdict names, so a verdict for one list's task #N never closes another list's. */
function verdictStamp(root: string, taskId: string): { run: string; task_list: string } {
  if (taskId === "") throw new Error("evidence_log: a final_verification names the run's final task in task_id");
  const list = readTaskList(root, latestSessionId() ?? process.env.CLAUDE_CODE_SESSION_ID ?? "");
  const task = list.tasks.find(({ id }) => id === taskId);
  if (task?.isFinal !== true) throw new Error(`evidence_log: task #${taskId} is not a final task on this session's task list; name the run's final task in task_id`);
  return { run: task.run, task_list: list.id };
}

async function evidenceLog(args: Record<string, unknown>): Promise<string> {
  const arg = argReader(args, "evidence_log").string;
  const type = arg("evidence_type");
  if (!(EVIDENCE_TYPES as readonly string[]).includes(type)) {
    throw new Error(`evidence_log: evidence_type must be one of ${EVIDENCE_TYPES.join(", ")}`);
  }
  const command = arg("command");
  const exitCode = args.exit_code;
  if (typeof exitCode !== "number" || !Number.isInteger(exitCode)) throw new Error("evidence_log: exit_code must be an integer");
  const snippet = arg("output_snippet");
  const verifiedBy = arg("verified_by", "");
  const taskId = capped(arg("task_id", ""), TASK_ID_MAX_CHARS);
  const root = rootOf(arg("working_directory", ""));
  const stamp = type === "final_verification" ? verdictStamp(root, taskId) : {};
  const tree = await workingTreeStamp(root);

  const entry = {
    type: type as EvidenceType,
    command: capped(command, COMMAND_MAX_CHARS),
    exit_code: exitCode,
    output_snippet: capped(snippet, SNIPPET_MAX_CHARS),
    timestamp: isoTimestamp(),
    ...(verifiedBy && { verified_by: capped(verifiedBy, VERIFIED_BY_MAX_CHARS) }),
    ...(taskId && { task_id: taskId }),
    ...stamp,
    ...(tree !== null && { tree }),
  };
  ensureStateDir(root);
  const total = await appendEvidence(root, entry);
  updateStatus(root);
  return `Evidence recorded: ${type} (exit ${exitCode}), ${total} total entries`;
}

function evidenceRead(args: Record<string, unknown>): string {
  const { entries } = readLedgerFile(ledgerPath(rootOf(stringArg(args, "working_directory", "", "evidence_read"))));
  if (entries.length === 0) return "No verification evidence recorded.";
  const limit = argReader(args, "evidence_read").integer("limit", DEFAULT_READ_ENTRIES);
  if (limit <= 0 || entries.length <= limit) return JSON.stringify({ entries }, null, 2);
  return `[showing ${limit} of ${entries.length} entries: pass limit=0 for all]\n${JSON.stringify({ entries: entries.slice(-limit) }, null, 2)}`;
}

const archiveMonth = (now: Date): string => `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

/** Moves all but the newest entries to the month's archive once the live ledger passes either cap. Returns how many moved. */
export async function rotateLedger(root: string, now = new Date()): Promise<number> {
  const path = ledgerPath(root);
  return withLock(`${path}.lock`, () => {
    const text = readOrNull(path);
    if (text === null) return 0;
    const ledger = parseLedger(path, text);
    if (Buffer.byteLength(text) <= ROTATE_BYTES && ledger.entries.length <= ROTATE_ENTRIES) return 0;
    const moved = ledger.entries.slice(0, -KEEP_ENTRIES);
    if (moved.length === 0) return 0;
    const archivePath = join(dirname(path), `verification-evidence.${archiveMonth(now)}.json`);
    const archive = readLedgerFile(archivePath);
    // Archive first: a crash between the two writes duplicates entries instead of losing them.
    writeLedger(archivePath, { ...archive, entries: [...archive.entries, ...moved] });
    writeLedger(path, { ...ledger, entries: ledger.entries.slice(-KEEP_ENTRIES) });
    return moved.length;
  });
}

export const tools: Tool[] = [
  {
    name: "evidence_log",
    description:
      "Record a build, test or lint run in the project's evidence log with its real exit code; a failing run counts too. OMCA's task gates read this log. Before completing a run's final task, log one final_verification entry with that task's task_id.",
    inputSchema: {
      type: "object",
      properties: {
        evidence_type: {
          type: "string",
          enum: [...EVIDENCE_TYPES],
          description:
            "final_verification is a run's verdict. A run's final task cannot complete until one with exit_code 0 names its task_id.",
        },
        command: { type: "string", description: "Command that was executed" },
        exit_code: {
          type: "integer",
          description: "The command's exit code. For final_verification, 0 records COMPLETE.",
        },
        output_snippet: { type: "string", description: "Relevant output snippet (truncated if needed)" },
        verified_by: { type: "string", default: "", description: "Agent or user who verified" },
        working_directory: WORKING_DIRECTORY,
        task_id: {
          type: "string",
          default: "",
          description: "The id of the run's final task this verdict covers. Set it on final_verification entries only.",
        },
      },
      required: ["evidence_type", "command", "exit_code", "output_snippet"],
    },
    annotations: {
      title: "Log verification evidence",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    _meta: {
      "anthropic/searchHint": "record a build, test, or lint verification result; required before any completion claim",
      "anthropic/alwaysLoad": true,
    },
    call: evidenceLog,
  },
  {
    name: "evidence_read",
    description:
      "Return the newest entries of the project's verification evidence log as JSON, oldest first, or a no-evidence message. It returns 20 entries by default and pass limit=0 for all; when entries are cut the output starts with a line giving the count shown and the total. The log is never cleared and is shared by all sessions in the project, so it holds entries from earlier sessions and other runs; there is no filter, and each output_snippet is capped at 2,000 characters. Use it to confirm what was logged, for example evidence a subagent reports.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          default: DEFAULT_READ_ENTRIES,
          description: "Newest entries to return, oldest first. Default 20. Set to 0 for every entry.",
        },
        working_directory: WORKING_DIRECTORY,
      },
    },
    annotations: { title: "Read verification evidence", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    _meta: {
      "anthropic/searchHint": "review all logged verification evidence before claiming a task complete",
      "anthropic/maxResultSizeChars": EVIDENCE_MAX_RESULT_CHARS,
    },
    call: evidenceRead,
  },
];
