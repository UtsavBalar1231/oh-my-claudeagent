import type { NativeTask } from "../src/core/native-tasks.ts";
import { changeRow, hasChanges, runSummary, taskChanges } from "../src/core/run-line.ts";
import { glyphs } from "../src/core/ui-kit.ts";
import type { Features } from "./dispatch.ts";
import { type Host, reason, resolvedSession, update } from "./host.ts";
import { isRemote, kitOf, Line } from "./ui.ts";

// The engine draws the turn line's mark in a column this wide, and the row starts under the line's words.
const MARK_CELLS = 2;
// A remote surface reports no viewport and clips a row itself, so its row is not cut to fit.
const UNCUT_COLUMNS = 10_000;
const ROW_PREFIX = "omca-tasks-";

// The list as the main turn started. A row's facts are fixed when it is placed and held in the
// placedRows atom, written only then, so a placed row redraws when one is placed and not on the
// tasks atom's 2 s writes. A resumed session brings no placed row back, so nothing outlives the session.
let before: readonly NativeTask[] | undefined;
let placed = 0;

async function listOf(host: Host): Promise<readonly NativeTask[] | undefined> {
  const { value } = await host.state.tasks.get();
  return value === undefined || value.error !== null ? undefined : value.tasks;
}

// No `requestId` means the row does not stand: a plugin holds at most 500 in a conversation. A row
// with one stands and draws when a surface attaches. A rejection is a client with no placed rows.
async function place(host: Host, id: string): Promise<void> {
  try {
    const result = await host.ui.place({ id });
    if (result.isPlaced || result.requestId !== undefined) return;
    host.log(`task-rows: the row was not placed: ${result.reason}`);
  } catch (error) {
    host.log(`task-rows: placing a row failed: ${reason(error)}`);
  }
  await update(host.state.placedRows, (rows = {}) => Object.fromEntries(Object.entries(rows).filter(([key]) => key !== id)));
}

export const taskRows: Features = {
  "turn.start": {
    async pre(host, e) {
      if (e.agentId === undefined) before = await listOf(host);
      return undefined;
    },
  },
  "turn.complete": {
    async post(host, e) {
      if (e.agentId !== undefined) return undefined;
      const [after, now] = await Promise.all([listOf(host), host.clock.now()]);
      const start = before;
      before = undefined;
      if (start === undefined || after === undefined) return undefined;
      const summary = runSummary(after);
      if (summary === undefined) return undefined;
      const changes = taskChanges(start, after, summary.name);
      if (!hasChanges(changes)) return undefined;
      placed += 1;
      const id = `${ROW_PREFIX}${now}-${placed}`;
      await update(host.state.placedRows, (rows = {}) => ({ ...rows, [id]: { summary, changes } }));
      await place(host, id);
      return undefined;
    },
  },
  "ui.render Placed": {
    async pre(host, e) {
      const { value: rows = {} } = await host.state.placedRows.get();
      const row = rows[e.props.id];
      if (row === undefined) return undefined;
      const kit = kitOf(host.ui.resolve(e), e.surface);
      const indent = isRemote(kit) ? 0 : MARK_CELLS;
      const columns = isRemote(kit) ? UNCUT_COLUMNS : (e.viewport?.columns ?? 80) - indent;
      const pieces = changeRow(row.summary, row.changes, glyphs(resolvedSession().glyphTier), columns);
      return { answer: kit.Box({ key: "omca-task-row", flexDirection: "row", paddingLeft: indent, children: [Line(kit, pieces)] }) };
    },
  },
};
