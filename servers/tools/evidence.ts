import { dirname, join } from "node:path";
import { EVIDENCE_TYPES, type EvidenceType } from "../../src/core/evidence.ts";
import { isRecord } from "../../src/core/tool-input.ts";
import { latestSessionId, touchSession } from "../hooks/session-state.ts";
import { ledgerPath, writeStatus } from "../hooks/status-file.ts";
import { ensureStateDir, readOrNull, withLock, writeFileAtomic } from "../io.ts";
import type { Tool } from "../omca.ts";
import { argReader, isoTimestamp, rootOf, stringArg, WORKING_DIRECTORY } from "./args.ts";

export const SNIPPET_MAX_CHARS = 2000;
export const COMMAND_MAX_CHARS = 2000;
export const VERIFIED_BY_MAX_CHARS = 200;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// A full read is many 2,000-character snippets; 100,000 holds about 50, well under the client's 500,000 ceiling.
const EVIDENCE_MAX_RESULT_CHARS = 100_000;
// The mod reads the ledger through $.fs.read, which fails past 4 MiB.
const ROTATE_BYTES = 1024 * 1024;
const ROTATE_ENTRIES = 1000;
export const KEEP_ENTRIES = 500;

type Ledger = Record<string, unknown> & { entries: unknown[] };

// The ledger is an append-only audit trail, so a file that does not parse is refused rather than replaced.
function parseLedger(path: string, text: string): Ledger {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  if (!isRecord(data) || !(data.entries === undefined || Array.isArray(data.entries))) {
    throw new Error(`${path} is not an evidence ledger ({"entries": [...]}); move it aside to keep logging evidence`);
  }
  return { ...data, entries: Array.isArray(data.entries) ? data.entries : [] };
}

function readLedger(path: string): Ledger {
  const text = readOrNull(path);
  return text === null ? { entries: [] } : parseLedger(path, text);
}

const capped = (value: string, max: number): string => (value.length > max ? Array.from(value).slice(0, max).join("") : value);

const writeJson = (path: string, data: unknown): void => writeFileAtomic(path, `${JSON.stringify(data, null, 2)}\n`);

function updateStatus(root: string): void {
  const sessionId = latestSessionId();
  if (sessionId === undefined) return;
  try {
    writeStatus(root, touchSession(sessionId), Date.now());
  } catch (error) {
    console.error(`omca: evidence was logged but the status file of session ${sessionId} was not updated:`, error);
  }
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
  const planSha256 = arg("plan_sha256", "");
  if (planSha256 !== "" && !SHA256_HEX.test(planSha256)) throw new Error("evidence_log: plan_sha256 must be 64 lowercase hex digits or empty");
  const root = rootOf(arg("working_directory", ""));

  const entry = {
    type: type as EvidenceType,
    command: capped(command, COMMAND_MAX_CHARS),
    exit_code: exitCode,
    output_snippet: capped(snippet, SNIPPET_MAX_CHARS),
    timestamp: isoTimestamp(),
    ...(verifiedBy && { verified_by: capped(verifiedBy, VERIFIED_BY_MAX_CHARS) }),
    ...(planSha256 && { plan_sha256: planSha256 }),
  };
  ensureStateDir(root);
  const path = ledgerPath(root);
  const total = await withLock(`${path}.lock`, () => {
    const ledger = readLedger(path);
    ledger.entries.push(entry);
    writeJson(path, ledger);
    return ledger.entries.length;
  });
  updateStatus(root);
  return `Evidence recorded: ${type} (exit ${exitCode}), ${total} total entries`;
}

function evidenceRead(args: Record<string, unknown>): string {
  const { entries } = readLedger(ledgerPath(rootOf(stringArg(args, "working_directory", "", "evidence_read"))));
  if (entries.length === 0) return "No verification evidence recorded.";
  return JSON.stringify({ entries }, null, 2);
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
    const archive = readLedger(archivePath);
    // Archive first: a crash between the two writes duplicates entries instead of losing them.
    writeJson(archivePath, { ...archive, entries: [...archive.entries, ...moved] });
    writeJson(path, { ...ledger, entries: ledger.entries.slice(-KEEP_ENTRIES) });
    return moved.length;
  });
}

export const tools: Tool[] = [
  {
    name: "evidence_log",
    description:
      "Record a build, test or lint run in the project's evidence log with its real exit code; a failing run counts too. OMCA's stop and task gates read this log. At the end of a plan, log one final_verification entry with plan_sha256 from boulder_progress.",
    inputSchema: {
      type: "object",
      properties: {
        evidence_type: {
          type: "string",
          enum: [...EVIDENCE_TYPES],
          description:
            "final_verification is the end-of-plan verdict. The plan's stop gate accepts one with exit_code 0 whose plan_sha256 matches the plan file as it is now.",
        },
        command: { type: "string", description: "Command that was executed" },
        exit_code: {
          type: "integer",
          description: "The command's exit code. For final_verification, 0 records COMPLETE.",
        },
        output_snippet: { type: "string", description: "Relevant output snippet (truncated if needed)" },
        verified_by: { type: "string", default: "", description: "Agent or user who verified" },
        working_directory: WORKING_DIRECTORY,
        plan_sha256: {
          type: "string",
          default: "",
          description:
            "The plan_sha256 boulder_progress returns. Set it on final_verification entries only.",
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
      "Return every entry in the project's verification evidence log as JSON, oldest first, or a no-evidence message. The log is never cleared and is shared by all sessions in the project, so it holds entries from earlier sessions and other plans; there is no filter or paging, and each output_snippet is capped at 2,000 characters. Use it to confirm what was logged, for example evidence a subagent reports.",
    inputSchema: { type: "object", properties: { working_directory: WORKING_DIRECTORY } },
    annotations: { title: "Read verification evidence", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    _meta: {
      "anthropic/searchHint": "review all logged verification evidence before claiming a task complete",
      "anthropic/maxResultSizeChars": EVIDENCE_MAX_RESULT_CHARS,
    },
    call: evidenceRead,
  },
];
