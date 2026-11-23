import { type MetricsRecord, outcomeOf, parseRecord, recordPath } from "../src/core/metrics.ts";
import type { Features } from "./dispatch.ts";
import { type Host, type State } from "./host.ts";

type Row = State["agents"][string];

async function locate(host: Host, agentId: string): Promise<{ root: string; sessionId: string; path: string } | undefined> {
  const [root, sessionId] = await Promise.all([host.session.root(), host.session.id()]);
  const path = recordPath(root, sessionId, agentId);
  if (path === undefined) host.log(`metrics: no record for session ${JSON.stringify(sessionId)} agent ${JSON.stringify(agentId)}`);
  return path === undefined ? undefined : { root, sessionId, path };
}

const write = (host: Host, path: string, record: MetricsRecord) => host.fs.write(path, `${JSON.stringify(record, null, 2)}\n`);

const running = (sessionId: string, agentId: string, row: Row): MetricsRecord => ({
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

async function agentRow(host: Host, agentId: string): Promise<Row | undefined> {
  const row = (await host.state.agents.get()).value?.[agentId];
  if (row === undefined) host.log(`metrics: agent ${agentId} is not tracked`);
  return row;
}

export const metrics: Features = {
  "agent.spawn": {
    async post(host, e, result) {
      if (result.deny !== undefined || result.agentId === undefined) return undefined;
      const [at, row] = await Promise.all([locate(host, result.agentId), agentRow(host, result.agentId)]);
      if (at === undefined || row === undefined || row.teammate) return undefined;
      const record = running(at.sessionId, result.agentId, row);
      await write(host, at.path, e.resume === undefined ? record : { ...record, input_tokens: row.inputTokens, output_tokens: row.outputTokens });
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
      if (row === undefined || row.teammate) return undefined;
      const endedAt = row.endedAt ?? (await host.clock.now());
      await write(host, at.path, {
        ...running(at.sessionId, e.agentId, row),
        ended_at: new Date(endedAt).toISOString(),
        duration_ms: endedAt - row.startedAt,
        input_tokens: row.inputTokens,
        output_tokens: row.outputTokens,
        // agents-tracker's turn.complete runs first and leaves the agent's final figure on its row.
        estimated_cost_usd: row.costUsd,
        outcome: outcomeOf(e),
        evidence_logged: row.evidenceLogged,
      });
      return undefined;
    },
  },
};
