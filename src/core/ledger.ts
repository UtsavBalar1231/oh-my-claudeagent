import { isSafeSessionId } from "./session-id.ts";

export const METRICS_DIR = ".omca/metrics";

const OUTCOMES = ["running", "completed", "aborted", "empty"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export type LedgerRecord = {
  session_id: string;
  agent_id: string;
  agent_type: string;
  model: string;
  effort: string | number | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number | null;
  outcome: Outcome;
  evidence_logged: boolean | null;
};

export type StatsRow = {
  agentType: string;
  count: number;
  medianDurationMs: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  unpriced: number;
  outcomes: Record<Outcome, number>;
  evidenceRate: number;
};

const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The record's path, or undefined when either id could leave the metrics directory. */
export function recordPath(root: string, sessionId: string, agentId: string): string | undefined {
  if (!isSafeSessionId(sessionId) || !SAFE_AGENT_ID.test(agentId)) return undefined;
  return `${root}/${METRICS_DIR}/${sessionId}/${agentId}.json`;
}

export function outcomeOf(turn: { isAborted: boolean; answer: string }): Exclude<Outcome, "running"> {
  if (turn.isAborted) return "aborted";
  return turn.answer.trim() === "" ? "empty" : "completed";
}

/** True when any evidence entry's timestamp falls inside [startMs, endMs], both ends included. */
export function isEvidenceLogged(ledgerText: string, startMs: number, endMs: number): boolean {
  const data: unknown = JSON.parse(ledgerText);
  const entries = typeof data === "object" && data !== null && "entries" in data ? data.entries : undefined;
  if (!Array.isArray(entries)) throw new Error("the evidence ledger holds no entries list");
  return entries.some((entry: unknown) => {
    const timestamp = typeof entry === "object" && entry !== null && "timestamp" in entry ? entry.timestamp : undefined;
    const at = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
    return at >= startMs && at <= endMs;
  });
}

const isCount = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isTime = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value));
const isOutcome = (value: unknown): value is Outcome => OUTCOMES.some((outcome) => outcome === value);

export function parseRecord(text: string): LedgerRecord | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const r = data as Record<string, unknown>;
  const isValid =
    typeof r["session_id"] === "string" &&
    typeof r["agent_id"] === "string" &&
    typeof r["agent_type"] === "string" &&
    r["agent_type"] !== "" &&
    typeof r["model"] === "string" &&
    (r["effort"] === null || typeof r["effort"] === "string" || typeof r["effort"] === "number") &&
    isTime(r["started_at"]) &&
    (r["ended_at"] === null || isTime(r["ended_at"])) &&
    (r["duration_ms"] === null || isCount(r["duration_ms"])) &&
    isCount(r["input_tokens"]) &&
    isCount(r["output_tokens"]) &&
    (r["estimated_cost_usd"] === null || (typeof r["estimated_cost_usd"] === "number" && r["estimated_cost_usd"] >= 0)) &&
    isOutcome(r["outcome"]) &&
    (r["evidence_logged"] === null || typeof r["evidence_logged"] === "boolean");
  return isValid ? (data as LedgerRecord) : undefined;
}

/** Parses each record's text, undefined for one that could not be read, and counts what it skipped. */
export function parseRecords(texts: readonly (string | undefined)[]): { records: LedgerRecord[]; skipped: number } {
  const records = texts.flatMap((text) => {
    const record = text === undefined ? undefined : parseRecord(text);
    return record === undefined ? [] : [record];
  });
  return { records, skipped: texts.length - records.length };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

// Costs are summed in the pricing table's integer unit, so a total is exact to the table's precision.
const UNITS_PER_USD = 1e8;

export function aggregate(records: readonly LedgerRecord[]): StatsRow[] {
  const groups = new Map<string, LedgerRecord[]>();
  for (const record of records) groups.set(record.agent_type, [...(groups.get(record.agent_type) ?? []), record]);
  return [...groups]
    .map(([agentType, group]): StatsRow => {
      const finished = group.filter((record) => record.outcome !== "running");
      const priced = finished.filter((record) => record.estimated_cost_usd !== null);
      const units = priced.reduce((sum, record) => sum + Math.round((record.estimated_cost_usd ?? 0) * UNITS_PER_USD), 0);
      const outcomes = { running: 0, completed: 0, aborted: 0, empty: 0 };
      for (const record of group) outcomes[record.outcome] += 1;
      return {
        agentType,
        count: group.length,
        medianDurationMs: median(finished.flatMap((record) => (record.duration_ms === null ? [] : [record.duration_ms]))),
        inputTokens: group.reduce((sum, record) => sum + record.input_tokens, 0),
        outputTokens: group.reduce((sum, record) => sum + record.output_tokens, 0),
        estimatedCostUsd: units / UNITS_PER_USD,
        unpriced: finished.length - priced.length,
        outcomes,
        evidenceRate: finished.length === 0 ? 0 : finished.filter((record) => record.evidence_logged === true).length / finished.length,
      };
    })
    .sort((a, b) => b.count - a.count || a.agentType.localeCompare(b.agentType));
}
