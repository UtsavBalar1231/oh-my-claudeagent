import type { AgentInfo, TurnUsage } from "claude-code";
import { oneLine } from "../src/core/band-model.ts";
import { firstLine, lastLine, toolDetail } from "../src/core/mission.ts";
import { fitEnd, type Glyphs, glyphs, isAsciiRequested } from "../src/core/ui-kit.ts";
import { redact } from "../src/core/visual.ts";
import type { Features } from "./dispatch.ts";
import { type Host, type State, update } from "./host.ts";

type Row = State["agents"][string];
type Lane = State["lanes"][string];
type Status = Row["status"];

const TOOL_HISTORY = 24;
const PROMPT_CELLS = 400;
const LINE_CELLS = 200;

let g: Glyphs | undefined;

// Secrets are masked before a lane is stored, and the excerpt is cut only after that, so a
// cut can never leave half a key the masks no longer match.
async function masked(host: Host, text: string, cells: number): Promise<string> {
  g ??= glyphs(isAsciiRequested(await host.env.OMCA_ASCII()));
  return fitEnd(redact(oneLine(text), "", g.mask).text, cells, g.ellipsis);
}

function editLane(host: Host, id: string, change: (lane: Lane) => Lane): Promise<void> {
  return update(host.state.lanes, (lanes) => {
    const lane = lanes?.[id];
    if (lanes === undefined || lane === undefined) return lanes;
    const next = change(lane);
    return next === lane ? lanes : { ...lanes, [id]: next };
  });
}

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
      const prompt = await masked(host, e.prompt, PROMPT_CELLS);
      await update(host.state.lanes, (lanes) => ({
        ...lanes,
        [agentId]: { prompt, tools: [], calls: 0, tool: null, output: "", result: "" },
      }));
      return undefined;
    },
  },
  "turn.complete": {
    async post(host, e) {
      if (e.agentId === undefined) return undefined;
      await endAgent(host, e.agentId, e.reason, e.usage, await host.clock.now());
      const result = await masked(host, firstLine(e.answer), LINE_CELLS);
      await editLane(host, e.agentId, (lane) => ({ ...lane, tool: null, result }));
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
      const last = result.toolUses.at(-1);
      const [detail, output] = await Promise.all([
        last === undefined ? undefined : masked(host, toolDetail(last.name, last.input, await host.session.root()), LINE_CELLS),
        masked(host, lastLine(result.answer), LINE_CELLS),
      ]);
      const names = result.toolUses.map((use) => use.name);
      await editLane(host, e.agentId, (lane) => {
        if (names.length === 0 && output === "" && lane.tool === null) return lane;
        return {
          ...lane,
          tools: [...lane.tools, ...names].slice(-TOOL_HISTORY),
          calls: lane.calls + names.length,
          tool: last === undefined || detail === undefined ? null : { name: last.name, detail },
          output: output === "" ? lane.output : output,
        };
      });
      return undefined;
    },
  },
};
