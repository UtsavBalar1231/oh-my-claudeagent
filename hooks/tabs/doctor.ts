import type { RenderElement } from "claude-code";
import type { Fix } from "../../src/core/doctor-checks.ts";
import { lastStart, stepStart, windowEnd } from "../../src/core/list-window.ts";
import { tildePath } from "../../src/core/path.ts";
import { COLORS, displayWidth, fitEnd, KEYS, levelMark, padEnd, wrapText } from "../../src/core/ui-kit.ts";
import * as doctor from "../doctor.ts";
import type { Host, State } from "../host.ts";
import type { Subcommand } from "../omca-router.ts";
import { keyButton, noticeRow, open, type TabView, type View } from "../pane.ts";

type Check = State["doctor"]["checks"][number];
type Applied = NonNullable<State["doctor"]["applied"]>;

const LABEL = 14;
const GAP = 3;
// Below this a detail column would be too narrow for the longest variable name it quotes.
const STACKED_BELOW = 64;
const DIFF_ROWS = 16;
const EDGE_ROWS = 2;
// Below this many rows for the checks the list is drawn whole and the engine scrolls it.
const MIN_WINDOW_ROWS = 3;
const SEVERITY: Readonly<Record<Check["level"], number>> = { fail: 0, warn: 1, info: 2, ok: 3 };
const FIXES: Readonly<Record<Fix, { key: string; label: string; done: string }>> = {
  "add-refresh-interval": { key: "i", label: "Add refreshInterval 5", done: "Added refreshInterval 5 to statusLine in" },
};

let first = 0;
let laid: { heights: readonly number[]; room: number } | undefined;

// Home and End ask for the drawn tree's whole height, which is one window here, so they jump to the ends.
export function scroll(by: number, contentRows: number): boolean {
  if (laid === undefined) return false;
  const rows = Math.abs(by) >= contentRows ? Math.sign(by) * laid.heights.reduce((sum, height) => sum + height, 0) : by;
  first = stepStart(laid.heights, first, rows, laid.room);
  return true;
}

export const command: Subcommand = async (host, e) => {
  first = 0;
  await doctor.markRunning(host);
  const answer = await open(host, e, "doctor");
  await doctor.run(host);
  return answer;
};

function summary(checks: readonly Check[], dot: string): string {
  const counts = (["fail", "warn", "info", "ok"] as const)
    .map((level) => [level, checks.filter((check) => check.level === level).length] as const)
    .filter(([, count]) => count > 0);
  return counts.map(([level, count]) => `${count} ${level}`).join(` ${dot} `);
}

type Rows = { element: RenderElement; height: number };

function checkRows(host: Host, view: View, check: Check): Rows {
  const { Box, Text } = view.kit;
  const { glyph, color } = levelMark(check.level, view.g);
  const isStacked = view.width < STACKED_BELOW;
  const indent = isStacked ? 2 : 2 + LABEL;
  const mark = Text({ color, children: [`${glyph} `] });
  const detail = wrapText(check.detail, view.width - indent);
  const line = (lead: RenderElement[], text: string) =>
    Box({ flexDirection: "row", children: [...lead, Text({ children: [text] })] });
  const lines = isStacked
    ? [
        Box({ flexDirection: "row", children: [mark, Text({ bold: true, children: [check.label] })] }),
        ...detail.map((text) => line([Text({ children: ["  "] })], text)),
      ]
    : detail.map((text, index) =>
        line(index === 0 ? [mark, Text({ children: [padEnd(check.label, LABEL)] })] : [Text({ children: [" ".repeat(indent)] })], text),
      );
  const fixRow = (which: Fix) =>
    Box({
      flexDirection: "row",
      children: [
        Text({ children: [" ".repeat(indent)] }),
        keyButton(view, FIXES[which].key, FIXES[which].label, () => doctor.fix(host, which)),
      ],
    });
  const children = check.fix === undefined ? lines : [...lines, fixRow(check.fix)];
  return { element: Box({ key: `check-${check.id}`, flexDirection: "column", children }), height: children.length };
}

function diffColor(line: string, index: number): { color?: (typeof COLORS)[keyof typeof COLORS]; dimColor?: boolean } {
  if (index < 2 || line.startsWith("@@")) return { dimColor: true };
  if (line.startsWith("+")) return { color: COLORS.ok };
  if (line.startsWith("-")) return { color: COLORS.fail };
  return {};
}

function appliedRows(view: View, applied: Applied): { elements: RenderElement[]; height: number } {
  const { Text } = view.kit;
  const ellipsis = view.g.ellipsis;
  const lines = applied.diff.split("\n");
  const shown = lines.slice(0, DIFF_ROWS);
  const { glyph, color } = levelMark("ok", view.g);
  const done = `${FIXES[applied.fix].done} ${tildePath(view.platform, applied.path, view.home)}`;
  const backup = `Backup: ${tildePath(view.platform, applied.backupPath, view.home)}`;
  const more = lines.length > shown.length;
  return {
    elements: [
      Text({ wrap: "wrap", children: [Text({ color, children: [`${glyph} `] }), done] }),
      Text({ dimColor: true, wrap: "wrap", children: [`  ${backup}`] }),
      ...shown.map((line, index) =>
        Text({ ...diffColor(line, index), children: [`  ${fitEnd(line, view.width - 2, ellipsis)}`] }),
      ),
      ...(more ? [Text({ dimColor: true, children: [`  ${ellipsis} ${lines.length - shown.length} more diff lines`] })] : []),
    ],
    height: wrapText(`${glyph} ${done}`, view.width).length + wrapText(backup, view.width - 2).length + shown.length + (more ? 1 : 0),
  };
}

export const view: TabView = async (host, view) => {
  const { Box, Text } = view.kit;
  const state = (await host.state.doctor.get()).value;
  const runKey = (label: string) => keyButton(view, KEYS.reload, label, () => doctor.run(host));
  const words = { loading: "Running the checks", empty: "The doctor checks have not run in this session." };
  laid = undefined;
  if (state === undefined) return [noticeRow(view, { kind: "empty" }, words), runKey("Run checks")];
  if (state.checks.length === 0) {
    if (state.isRunning) return [noticeRow(view, { kind: "loading" }, words)];
    if (state.error !== null) return [noticeRow(view, { kind: "error", reason: state.error }, words), runKey("Run again")];
    return [noticeRow(view, { kind: "empty" }, words), runKey("Run checks")];
  }
  const button = runKey("Run again");
  const status = state.isRunning
    ? `Running the checks${view.g.ellipsis}`
    : `${summary(state.checks, view.g.dot)} ${view.g.dot} checked ${new Date(state.ranAt).toTimeString().slice(0, 5)}`;
  const room = view.width - displayWidth(`${KEYS.reload}: Run again`) - GAP;
  const error = state.error === null ? undefined : `${view.g.cross} ${state.error}`;
  const applied = state.applied === null ? undefined : appliedRows(view, state.applied);
  const head = [
    Box({ key: "head", flexDirection: "row", columnGap: GAP, children: [button, Text({ dimColor: true, children: [fitEnd(status, room, view.g.ellipsis)] })] }),
    ...(error === undefined ? [] : [Text({ color: COLORS.fail, wrap: "wrap", children: [error] })]),
    ...(applied?.elements ?? []),
  ];
  const headHeight = 1 + (error === undefined ? 0 : wrapText(error, view.width).length) + (applied?.height ?? 0);
  const checks = state.checks.toSorted((a, b) => SEVERITY[a.level] - SEVERITY[b.level]).map((check) => checkRows(host, view, check));
  const heights = checks.map(({ height }) => height);
  const space = view.rows - headHeight;
  const capacity = space - EDGE_ROWS;
  if (heights.reduce((sum, height) => sum + height, 0) <= space || capacity < MIN_WINDOW_ROWS) {
    return [...head, ...checks.map(({ element }) => element)];
  }
  first = Math.min(first, lastStart(heights, capacity));
  laid = { heights, room: capacity };
  const end = windowEnd(heights, first, capacity);
  const edge = (text: string) => Text({ dimColor: true, children: [text === "" ? " " : fitEnd(text, view.width, view.g.ellipsis)] });
  const shown = heights.slice(first, end).reduce((sum, height) => sum + height, 0);
  const blank = () => Text({ children: [" "] });
  // The engine raises ui.scroll only for a tree taller than the body, so this one row past the
  // window is what brings the arrows and the wheel to `scroll`.
  return [
    ...head,
    edge(first > 0 ? `  ${view.g.up} ${first} more` : ""),
    ...checks.slice(first, end).map(({ element }) => element),
    ...Array.from({ length: Math.max(0, capacity - shown) }, blank),
    edge(end < checks.length ? `  ${view.g.down} ${checks.length - end} more ${view.g.dot} ${view.g.up}${view.g.down} scroll` : ""),
    blank(),
  ];
};
