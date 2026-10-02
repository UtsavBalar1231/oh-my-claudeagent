import type { AgentInfo, TurnUsage } from "claude-code";
import type { Features } from "./dispatch.ts";
import { type Host, type State, update } from "./host.ts";

type Row = State["agents"][string];
type Status = Row["status"];

const inputTokens = (usage: TurnUsage) =>
  usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;

function edit(host: Host, id: string, change: (row: Row) => Row): Promise<void> {
  return update(host.state.agents, (agents) => {
    const row = agents?.[id];
    if (agents === undefined || row === undefined || row.endedAt !== null) return agents;
    return { ...agents, [id]: change(row) };
  });
}

function endAgent(host: Host, id: string, status: Status, usage: TurnUsage | undefined, at: number): Promise<void> {
  return edit(host, id, (row) => ({
    ...row,
    status,
    endedAt: at,
    ...(usage === undefined ? {} : { inputTokens: inputTokens(usage), outputTokens: usage.output_tokens }),
  }));
}

const LISTED_STATUS: Readonly<Record<string, Status>> = { completed: "answer", failed: "error", killed: "aborted" };

export function reconcile(host: Host, listed: readonly AgentInfo[], at: number): Promise<void> {
  return update(host.state.agents, (agents) => {
    if (agents === undefined) return agents;
    const ended = Object.entries(agents).flatMap(([id, row]) => {
      if (row.endedAt !== null) return [];
      const info = listed.find((agent) => agent.id === id);
      if (info?.status === "running") return [];
      const status = info === undefined ? "gone" : (LISTED_STATUS[info.status] ?? "gone");
      return [[id, { ...row, status, endedAt: at }] as const];
    });
    return ended.length === 0 ? agents : { ...agents, ...Object.fromEntries(ended) };
  });
}

export const agentsTracker: Features = {
  "agent.spawn": {
    async post(host, e, result) {
      if (result.deny !== undefined || result.agentId === undefined) return undefined;
      const { agentId, model } = result;
      const startedAt = await host.clock.now();
      await update(host.state.agents, (agents) => ({
        ...agents,
        [agentId]: {
          type: e.subagentType,
          description: e.description,
          model,
          effort: null,
          startedAt,
          endedAt: null,
          inputTokens: 0,
          outputTokens: 0,
          status: "running",
        },
      }));
      return undefined;
    },
  },
  "turn.complete": {
    async post(host, e) {
      if (e.agentId !== undefined) await endAgent(host, e.agentId, e.reason, e.usage, await host.clock.now());
      return undefined;
    },
  },
  "turn.step": {
    async post(host, e, result) {
      if (e.agentId === undefined) return undefined;
      const { usage } = result;
      await edit(host, e.agentId, (row) => ({
        ...row,
        effort: e.effort ?? row.effort,
        inputTokens: row.inputTokens + (usage === null ? 0 : inputTokens(usage)),
        outputTokens: row.outputTokens + (usage?.output_tokens ?? 0),
      }));
      return undefined;
    },
  },
};
