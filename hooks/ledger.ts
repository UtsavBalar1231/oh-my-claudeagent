import { isEvidenceLogged, type LedgerRecord, outcomeOf, parseRecord, recordPath } from "../src/core/ledger.ts";
import { estimateCostUsd } from "../src/core/pricing.ts";
import type { Features } from "./dispatch.ts";
import type { Host, State } from "./host.ts";
import { reason } from "./pane.ts";

type Row = State["agents"][string];

const EVIDENCE = ".omca/evidence/verification-evidence.json";
const NO_USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

async function locate(host: Host, agentId: string): Promise<{ root: string; sessionId: string; path: string } | undefined> {
  const [root, sessionId] = await Promise.all([host.session.root(), host.session.id()]);
  const path = recordPath(root, sessionId, agentId);
  if (path === undefined) host.log(`ledger: no record for session ${JSON.stringify(sessionId)} agent ${JSON.stringify(agentId)}`);
  return path === undefined ? undefined : { root, sessionId, path };
}

const write = (host: Host, path: string, record: LedgerRecord) => host.fs.write(path, `${JSON.stringify(record, null, 2)}\n`);

const running = (sessionId: string, agentId: string, row: Row): LedgerRecord => ({
  session_id: sessionId,
  agent_id: agentId,
  agent_type: row.type,
  model: row.model,
  effort: row.effort,
  started_at: new Date(row.startedAt).toISOString(),
  ended_at: null,
  duration_ms: null,
  input_tokens: 0,
  output_tokens: 0,
  estimated_cost_usd: null,
  outcome: "running",
  evidence_logged: null,
});

// null when the ledger exists but cannot be read: unknown, not "no evidence".
async function evidenceLogged(host: Host, root: string, startMs: number, endMs: number): Promise<boolean | null> {
  const path = `${root}/${EVIDENCE}`;
  try {
    return (await host.fs.exists(path)) && isEvidenceLogged(await host.fs.read(path), startMs, endMs);
  } catch (error) {
    host.log(`ledger: could not read ${EVIDENCE}: ${reason(error)}`);
    return null;
  }
}

async function agentRow(host: Host, agentId: string): Promise<Row | undefined> {
  const row = (await host.state.agents.get()).value?.[agentId];
  if (row === undefined) host.log(`ledger: agent ${agentId} is not tracked`);
  return row;
}

export const ledger: Features = {
  "agent.spawn": {
    async post(host, _e, result) {
      if (result.deny !== undefined || result.agentId === undefined) return undefined;
      const [at, row] = await Promise.all([locate(host, result.agentId), agentRow(host, result.agentId)]);
      if (at !== undefined && row !== undefined) await write(host, at.path, running(at.sessionId, result.agentId, row));
      return undefined;
    },
  },
  "turn.complete": {
    async post(host, e) {
      if (e.agentId === undefined) return undefined;
      const at = await locate(host, e.agentId);
      if (at === undefined || !(await host.fs.exists(at.path))) return undefined;
      if (parseRecord(await host.fs.read(at.path))?.outcome !== "running") return undefined;
      const row = await agentRow(host, e.agentId);
      if (row === undefined) return undefined;
      const endedAt = row.endedAt ?? (await host.clock.now());
      // A turn without usage counted nothing, by the engine's contract; tokens its steps did
      // count without one cannot be split into priced kinds, so they stay unpriced.
      const usage = e.usage ?? (row.inputTokens + row.outputTokens === 0 ? { ...NO_USAGE, model: row.model } : undefined);
      await write(host, at.path, {
        ...running(at.sessionId, e.agentId, row),
        ended_at: new Date(endedAt).toISOString(),
        duration_ms: endedAt - row.startedAt,
        input_tokens: row.inputTokens,
        output_tokens: row.outputTokens,
        estimated_cost_usd: usage === undefined ? null : estimateCostUsd(usage.model, usage),
        outcome: outcomeOf(e),
        evidence_logged: await evidenceLogged(host, at.root, row.startedAt, endedAt),
      });
      return undefined;
    },
  },
};
