import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EVIDENCE_TYPES, type EvidenceType } from "../../src/core/evidence.ts";
import { latestSessionId, touchSession } from "../hooks/session-state.ts";
import { ledgerPath, writeStatus } from "../hooks/status-file.ts";
import { ensureStateDir, projectRoot, withLock, writeFileAtomic } from "../io.ts";
import { isObject } from "../jsonrpc.ts";
import type { Tool } from "../omca.ts";

export const SNIPPET_MAX_CHARS = 2000;
// A full read is many 2,000-character snippets; 100,000 holds about 50, well under the client's 500,000 ceiling.
const EVIDENCE_MAX_RESULT_CHARS = 100_000;
// The mod reads the ledger through $.fs.read, which fails past 4 MiB.
export const ROTATE_BYTES = 1024 * 1024;
export const ROTATE_ENTRIES = 1000;
export const KEEP_ENTRIES = 500;

type Ledger = Record<string, unknown> & { entries: unknown[] };

const WORKING_DIRECTORY = { type: "string", default: "", description: "Project root (auto-detected from git)" };

function stringArg(args: Record<string, unknown>, tool: string, name: string, fallback?: string): string {
  const value = args[name];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string") throw new Error(`${tool}: ${name} must be a string`);
  return value;
}

const rootOf = (workingDirectory: string): string => projectRoot(workingDirectory || process.cwd());

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

// The ledger is an append-only audit trail, so a file that does not parse is refused rather than replaced.
function parseLedger(path: string, text: string): Ledger {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  if (!isObject(data) || !(data.entries === undefined || Array.isArray(data.entries))) {
    throw new Error(`${path} is not an evidence ledger ({"entries": [...]}); move it aside to keep logging evidence`);
  }
  return { ...data, entries: Array.isArray(data.entries) ? data.entries : [] };
}

function readLedger(path: string): Ledger {
  const text = readText(path);
  return text === undefined ? { entries: [] } : parseLedger(path, text);
}

const writeJson = (path: string, data: unknown): void => writeFileAtomic(path, `${JSON.stringify(data, null, 2)}\n`);

const timestamp = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

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
  const type = stringArg(args, "evidence_log", "evidence_type");
  if (!(EVIDENCE_TYPES as readonly string[]).includes(type)) {
    throw new Error(`evidence_log: evidence_type must be one of ${EVIDENCE_TYPES.join(", ")}`);
  }
  const command = stringArg(args, "evidence_log", "command");
  const exitCode = args.exit_code;
  if (typeof exitCode !== "number" || !Number.isInteger(exitCode)) throw new Error("evidence_log: exit_code must be an integer");
  const snippet = stringArg(args, "evidence_log", "output_snippet");
  const verifiedBy = stringArg(args, "evidence_log", "verified_by", "");
  const planSha256 = stringArg(args, "evidence_log", "plan_sha256", "");
  const root = rootOf(stringArg(args, "evidence_log", "working_directory", ""));

  const entry = {
    type: type as EvidenceType,
    command,
    exit_code: exitCode,
    output_snippet: snippet.length > SNIPPET_MAX_CHARS ? Array.from(snippet).slice(0, SNIPPET_MAX_CHARS).join("") : snippet,
    timestamp: timestamp(),
    ...(verifiedBy && { verified_by: verifiedBy }),
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
  const path = ledgerPath(rootOf(stringArg(args, "evidence_read", "working_directory", "")));
  let entries: unknown;
  try {
    entries = JSON.parse(readText(path) ?? "{}").entries;
  } catch {
    entries = undefined;
  }
  if (!Array.isArray(entries) || entries.length === 0) return "No verification evidence recorded.";
  return JSON.stringify({ entries }, null, 2);
}

const archiveMonth = (now: Date): string => `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

/** Moves all but the newest entries to the month's archive once the live ledger passes either cap. Returns how many moved. */
export async function rotateLedger(root: string, now = new Date()): Promise<number> {
  const path = ledgerPath(root);
  return withLock(`${path}.lock`, () => {
    const text = readText(path);
    if (text === undefined) return 0;
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
      "Append a timestamped entry to the project's verification evidence log (.omca/evidence/verification-evidence.json), the audit trail OMCA's gates read. Use it after each build, test, or lint run, with the run's real exit code (a failing run is still evidence), and once at the end of a plan for the final_verification verdict. Two gates read the log: a plan-bound session cannot stop until a final_verification entry matches the plan (see evidence_type), and when task tools are enabled a TaskCompleted hook refuses to close a task if a verification run finished after the log was last written. Entries are never removed and are shared by every session in the project. Returns a confirmation with the total entry count.",
    inputSchema: {
      type: "object",
      properties: {
        evidence_type: {
          type: "string",
          enum: [...EVIDENCE_TYPES],
          description:
            "Kind of evidence. final_verification is the end-of-plan completeness verdict. The plan Stop gate accepts only a final_verification entry with exit_code 0 whose plan_sha256 matches the plan file's current SHA-256; an entry without plan_sha256 matches any plan, and editing the plan after logging makes a scoped entry stop matching.",
        },
        command: { type: "string", description: "Command that was executed" },
        exit_code: {
          type: "integer",
          description: "Exit code of the command. For final_verification, 0 records COMPLETE and any other value INCOMPLETE.",
        },
        output_snippet: { type: "string", description: "Relevant output snippet (truncated if needed)" },
        verified_by: { type: "string", default: "", description: "Agent or user who verified" },
        working_directory: WORKING_DIRECTORY,
        plan_sha256: {
          type: "string",
          default: "",
          description:
            "Hex SHA-256 of the plan file's current bytes, as `boulder_progress` returns it in `plan_sha256`. Set it on final_verification entries so the verdict applies only to this version of the plan; leave empty for other types.",
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
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    _meta: {
      "anthropic/searchHint": "review all logged verification evidence before claiming a task complete",
      "anthropic/maxResultSizeChars": EVIDENCE_MAX_RESULT_CHARS,
    },
    call: evidenceRead,
  },
];
