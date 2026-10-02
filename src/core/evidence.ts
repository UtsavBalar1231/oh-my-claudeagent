export const EVIDENCE_TYPES = [
  "build",
  "test",
  "lint",
  "manual",
  "final_verification",
] as const;

export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export interface EvidenceEntry {
  type: EvidenceType;
  command: string;
  exit_code: number;
  output_snippet: string;
  timestamp: string;
  verified_by?: string;
  plan_sha256?: string;
}

// A verification older than this belongs to earlier work, not the task completing now.
export const MAX_SLOT_AGE_SECONDS = 3600;

export function isSlotRecent(nowSeconds: number, slotAt: number): boolean {
  return nowSeconds - slotAt <= MAX_SLOT_AGE_SECONDS;
}

// exFAT stores modification times to 2 s, and an SMB or NFS server's clock can lag the client's.
export const MTIME_SLACK_SECONDS = 2;

/** True when the ledger was written at or after the verification command finished, give or take the mtime slack. */
export function ledgerCoversSlot(ledgerMtimeSeconds: number, slotAt: number): boolean {
  return ledgerMtimeSeconds + MTIME_SLACK_SECONDS >= slotAt;
}

// jq truthiness: only null and false are falsy, so an empty string still counts.
const present = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== false;

const TRUTHY_FIELDS = ["type", "command", "output_snippet", "timestamp"];

/** The structural check the TaskCompleted gate applies to a ledger it did not write. */
export function isWellFormedLedger(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const entries = (data as { entries?: unknown }).entries;
  if (!Array.isArray(entries) || entries.length === 0) return false;
  return entries.every((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return false;
    const e = entry as Record<string, unknown>;
    // Unlike the fields above, the gate tests exit_code only against null, so 0 and false pass.
    return TRUTHY_FIELDS.every((k) => present(e[k])) && e["exit_code"] != null;
  });
}
