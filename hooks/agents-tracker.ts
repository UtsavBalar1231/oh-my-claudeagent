import type { AgentInfo, TurnUsage } from "claude-code";
import { firstLine, lastLine, STATUS_WORDS, toolDetail } from "../src/core/mission.ts";
import { taskReference } from "../src/core/plan-reader.ts";
import { estimateCostUsd } from "../src/core/pricing.ts";
import { fitEnd, glyphs, oneLine } from "../src/core/ui-kit.ts";
import { redact } from "../src/core/visual.ts";
import type { Features } from "./dispatch.ts";
import { type Host, sessionOf, type State, update } from "./host.ts";

type Row = State["agents"][string];
type Lane = State["lanes"][string];
type Page = State["pages"][string];
type Call = Page["calls"][number];
type Status = Row["status"];

const PROMPT_CELLS = 400;
const LINE_CELLS = 200;
const MAX_BRIEF = 8 * 1024;
const MAX_REPLY = 4 * 1024;
const MAX_CALLS = 120;
const MAX_PAGES = 20;
const MAX_PENDING = 500;

// A subagent's tool calls as `tool.call` saw them, the most recently calling agent last; the page atom is filled from it.
const calls = new Map<string, Call[]>();
// A call's start, dropped when its `post` runs; one whose `next` rejected never reaches `post`, so
// the agent's `turn.complete` and the cap bound what such calls leave behind.
const startedAt = new Map<string, { agentId: string; at: number }>();

// Secrets are masked before a lane is stored, and the excerpt is cut only after that, so a
// cut can never leave half a key the masks no longer match.
async function masked(host: Host, text: string, cells: number): Promise<string> {
  const g = glyphs((await sessionOf(host)).glyphTier);
  return fitEnd(redact(oneLine(text), "", g.mask).text, cells, g.ellipsis);
}

async function maskedText(host: Host, text: string, max: number): Promise<string> {
  const g = glyphs((await sessionOf(host)).glyphTier);
  return redact(text, "", g.mask).text.slice(0, max).replace(/[\uD800-\uDBFF]$/, "");
}

const WAVE_TOAST_MS = 5000;
// The subagents that ended since the last wave closed; a wave closes when none is left running.
const finished: { name: string; status: Status }[] = [];

async function closeWave(host: Host): Promise<void> {
  const { value: agents = {} } = await host.state.agents.get();
  if (finished.length === 0 || Object.values(agents).some((row) => !row.teammate && row.status === "running")) return;
  const { dot } = glyphs((await sessionOf(host)).glyphTier);
  const [only] = finished;
  const counts = new Map<Status, number>();
  for (const { status } of finished) if (status !== "answer") counts.set(status, (counts.get(status) ?? 0) + 1);
  const unlike = [...counts].map(([status, count]) => `${count} ${STATUS_WORDS[status] ?? "ended"}`).join(` ${dot} `);
  const text =
    only !== undefined && finished.length === 1
      ? `${only.name} ${only.status === "answer" ? "finished" : (STATUS_WORDS[only.status] ?? "ended")}`
      : `${finished.length} agents finished${unlike === "" ? "" : ` ${dot} ${unlike}`}`;
  finished.length = 0;
  host.ui.toast(text, { timeoutMs: WAVE_TOAST_MS });
}

// Deleting first moves the agent to the newest end, so the cap drops the agent idle longest.
function record(id: string, call: Call): void {
  const kept = calls.get(id) ?? [];
  calls.delete(id);
  calls.set(id, [...kept, call].slice(-MAX_CALLS));
  for (const oldest of calls.keys()) {
    if (calls.size <= MAX_PAGES) break;
    calls.delete(oldest);
  }
}

/** Reads the agent's transcript and keeps its page: the brief, the recorded calls and the latest reply. */
export async function loadPage(host: Host, id: string): Promise<void> {
  const [found, { value: lanes }, { value: agents = {} }] = await Promise.all([
    host.session.transcript({ agentId: id }),
    host.state.lanes.get(),
    host.state.agents.get(),
  ]);
  const messages = Array.isArray(found) ? found : [];
  const brief = messages.find((message) => message.role === "user" && message.text !== "")?.text;
  const reply = messages.findLast((message) => message.role === "assistant" && message.text !== "")?.text;
  const lane = lanes?.[id];
  const page: Page = {
    brief: await maskedText(host, brief ?? lane?.prompt ?? "", MAX_BRIEF),
    source: brief === undefined ? "prompt" : "messages",
    calls: [...(calls.get(id) ?? [])],
    reply: await maskedText(host, reply ?? (lane === undefined ? "" : lane.result || lane.output), MAX_REPLY),
  };
  const newest = (key: string) => agents[key]?.startedAt ?? 0;
  await update(host.state.pages, (pages) => {
    const kept = Object.entries(pages ?? {})
      .filter(([key]) => key !== id)
      .sort(([a], [b]) => newest(b) - newest(a))
      .slice(0, MAX_PAGES - 1);
    return Object.fromEntries([...kept, [id, page]]);
  });
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

function stepCost(total: number | null, usage: TurnUsage | null): number | null {
  if (total === null || usage === null) return total;
  const cost = estimateCostUsd(usage.model, usage);
  return cost === null ? null : total + cost;
}

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
    ...(row.teammate ? { status: "idle" as const } : { status, endedAt: at }),
    ...(usage === undefined ? {} : { inputTokens: inputTokens(usage), outputTokens: usage.output_tokens }),
  }));
}

const LISTED_STATUS: Readonly<Record<string, Status>> = { completed: "answer", failed: "error", killed: "aborted" };
const LISTED_OPEN: Readonly<Record<string, Status>> = { running: "running", idle: "idle", waiting: "waiting", pending: "pending" };

export async function reconcile(host: Host, listed: readonly AgentInfo[], at: number): Promise<void> {
  let ended: { name: string; status: Status }[] = [];
  await update(host.state.agents, (agents) => {
    ended = [];
    if (agents === undefined) return agents;
    const changed = Object.entries(agents).flatMap(([id, row]) => {
      if (row.endedAt !== null) return [];
      const info = listed.find((agent) => agent.id === id);
      const open = info === undefined ? undefined : LISTED_OPEN[info.status];
      if (open !== undefined) return open === row.status ? [] : [[id, { ...row, status: open }] as const];
      const status = info === undefined ? "gone" : (LISTED_STATUS[info.status] ?? "gone");
      if (!row.teammate) ended.push({ name: row.type.replace(/^.*:/, ""), status });
      return [[id, { ...row, status, endedAt: at }] as const];
    });
    return changed.length === 0 ? agents : { ...agents, ...Object.fromEntries(changed) };
  });
  if (ended.length === 0) return;
  finished.push(...ended);
  await closeWave(host);
}

export const agentsTracker: Features = {
  "agent.spawn": {
    async post(host, e, result) {
      if (result.deny !== undefined || result.agentId === undefined) return undefined;
      const { agentId, model } = result;
      const startedAt = await host.clock.now();
      const task = taskReference(e.prompt, e.description);
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
          costUsd: 0,
          status: "running",
          teammate: e.isTeammate === true,
          ...(task === undefined ? {} : { task }),
        },
      }));
      const prompt = await masked(host, e.prompt, PROMPT_CELLS);
      await update(host.state.lanes, (lanes) => ({
        ...lanes,
        [agentId]: { prompt, calls: 0, tool: null, output: "", result: "" },
      }));
      return undefined;
    },
  },
  "turn.complete": {
    async post(host, e) {
      if (e.agentId === undefined) return undefined;
      const { value: agents } = await host.state.agents.get();
      const before = agents?.[e.agentId];
      await endAgent(host, e.agentId, e.reason, e.usage, await host.clock.now());
      if (before !== undefined && before.endedAt === null && !before.teammate) {
        finished.push({ name: before.type.replace(/^.*:/, ""), status: e.reason });
        await closeWave(host);
      }
      const result = await masked(host, firstLine(e.answer), LINE_CELLS);
      await editLane(host, e.agentId, (lane) => ({ ...lane, tool: null, result }));
      for (const [callId, call] of startedAt) if (call.agentId === e.agentId) startedAt.delete(callId);
      await loadPage(host, e.agentId);
      return undefined;
    },
  },
  "tool.call": {
    async pre(host, e) {
      if (e.agentId === undefined) return undefined;
      startedAt.set(e.tool_use_id, { agentId: e.agentId, at: await host.clock.now() });
      for (const oldest of startedAt.keys()) {
        if (startedAt.size <= MAX_PENDING) break;
        startedAt.delete(oldest);
      }
      return undefined;
    },
    async post(host, e, result) {
      const { agentId } = e;
      if (agentId === undefined) return undefined;
      const [now, root] = await Promise.all([host.clock.now(), host.session.root()]);
      const began = startedAt.get(e.tool_use_id)?.at;
      startedAt.delete(e.tool_use_id);
      record(agentId, {
        tool: e.tool,
        summary: await masked(host, toolDetail(e.tool, e, root), LINE_CELLS),
        ok: result.deny === undefined && result.isError !== true,
        durationMs: began === undefined ? null : now - began,
      });
      return undefined;
    },
  },
  "turn.step": {
    async post(host, e, result) {
      if (e.agentId === undefined) return undefined;
      const { usage } = result;
      await edit(host, e.agentId, (row) => ({
        ...row,
        status: "running",
        effort: e.effort ?? row.effort,
        inputTokens: row.inputTokens + (usage === null ? 0 : inputTokens(usage)),
        outputTokens: row.outputTokens + (usage?.output_tokens ?? 0),
        costUsd: stepCost(row.costUsd, usage),
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
          calls: lane.calls + names.length,
          tool: last === undefined || detail === undefined ? null : { name: last.name, detail },
          output: output === "" ? lane.output : output,
        };
      });
      return undefined;
    },
  },
};
