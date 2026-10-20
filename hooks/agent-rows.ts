import { lookOf } from "../src/core/agent-type.ts";
import { type Launch, launchRow, type Notice, noticeRows, noticeStatus } from "../src/core/notice.ts";
import { field, inputText } from "../src/core/tool-input.ts";
import { glyphs } from "../src/core/ui-kit.ts";
import type { Features } from "./dispatch.ts";
import { resolvedSession, type State, update } from "./host.ts";
import { kitOf, Line } from "./ui.ts";

const KEPT_NOTICES = 50;
// A cell kept free at the row's end, so the flush-right facts never touch a docked pane's border,
// and a row no wider than this, so on a wide terminal the facts stay within a glance of the task.
const GUTTER = 1;
const MAX_COLUMNS = 100;

const ENDED: Readonly<Record<string, Notice["status"]>> = { answer: "answer", aborted: "aborted", refusal: "refusal", error: "error" };

function noticeOf(row: State["agents"][string], lane: State["lanes"][string] | undefined): Notice {
  return {
    type: lookOf(row),
    description: row.description,
    status: ENDED[row.status] ?? "gone",
    durationMs: row.endedAt === null ? null : row.endedAt - row.startedAt,
    calls: lane?.calls ?? 0,
    tokens: row.inputTokens + row.outputTokens,
    result: lane?.result ?? "",
  };
}

function stateOf({ isRunning, isErrored, isInterrupted }: { isRunning: boolean; isErrored: boolean; isInterrupted: boolean }): Launch["state"] {
  if (isInterrupted) return "stopped";
  if (isErrored) return "failed";
  return isRunning ? "running" : "done";
}

// The agent's own rows in Claude Code's transcript, on the terminal: an Agent call that draws a row
// of its own, and the notice its agent's end sends. A launch of several agents at once is drawn by
// the engine as one block no hook reaches. ctrl+o and every other surface keep the engine's rows.
export const agentRows: Features = {
  // Runs after the agents tracker has closed the agent's row and stored its reply's first line.
  "turn.complete": {
    async post(host, e) {
      const { agentId } = e;
      if (agentId === undefined) return undefined;
      const [{ value: agents = {} }, { value: lanes = {} }] = await Promise.all([host.state.agents.get(), host.state.lanes.get()]);
      const row = agents[agentId];
      if (row === undefined || row.teammate) return undefined;
      const notice = noticeOf(row, lanes[agentId]);
      await update(host.state.notices, (all) =>
        Object.fromEntries([...Object.entries(all ?? {}).filter(([id]) => id !== agentId), [agentId, notice] as const].slice(-KEPT_NOTICES)),
      );
      return undefined;
    },
  },
  "ui.render ToolUse": {
    pre(host, e) {
      const props: Readonly<Record<string, unknown>> = { ...e.props };
      const type = inputText(e.props.input, "subagent_type");
      if (e.surface !== "terminal" || props["isExpanded"] === true || type === "") return undefined;
      const launch: Launch = {
        type,
        description: inputText(e.props.input, "description"),
        isBackground: field(e.props.input, "run_in_background") === true,
        state: stateOf(e.props),
      };
      const kit = kitOf(host.ui.resolve(e), e.surface);
      const row = launchRow(launch, glyphs(resolvedSession().glyphTier), Math.min(MAX_COLUMNS, (e.viewport?.columns ?? 80) - GUTTER));
      return { answer: kit.Box({ key: "omca-launch", marginTop: 1, children: [Line(kit, row)] }) };
    },
  },
  "ui.render UserMessage": {
    async pre(host, e) {
      const { task, origin, isExpanded } = e.props;
      if (e.surface !== "terminal" || isExpanded || origin.kind !== "task-notification" || task?.id === undefined) return undefined;
      const notice = (await host.state.notices.get()).value?.[task.id];
      if (notice === undefined) return undefined;
      const shown: Notice = { ...notice, status: noticeStatus(task.status, notice.status), durationMs: task.durationMs ?? notice.durationMs };
      const kit = kitOf(host.ui.resolve(e), e.surface);
      const rows = noticeRows(shown, glyphs(resolvedSession().glyphTier), Math.min(MAX_COLUMNS, (e.viewport?.columns ?? 80) - GUTTER));
      return { answer: kit.Box({ key: "omca-notice", flexDirection: "column", marginTop: 1, children: rows.map((pieces) => Line(kit, pieces)) }) };
    },
  },
};
