import type { RenderElement } from "claude-code";
import type { Fix } from "../../src/core/doctor-checks.ts";
import { tildePath } from "../../src/core/plan-reader.ts";
import { COLORS, displayWidth, fitEnd, KEYS, levelMark, padEnd } from "../../src/core/ui-kit.ts";
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
const SEVERITY: Readonly<Record<Check["level"], number>> = { fail: 0, warn: 1, info: 2, ok: 3 };
const FIXES: Readonly<Record<Fix, { key: string; label: string; done: string }>> = {
  "add-refresh-interval": { key: "i", label: "Add refreshInterval 5", done: "Added refreshInterval 5 to statusLine in" },
};

export const command: Subcommand = async (host, e) => {
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

function checkRow(host: Host, view: View, check: Check): RenderElement {
  const { Box, Text } = view.kit;
  const { glyph, color } = levelMark(check.level, view.g);
  const isStacked = view.width < STACKED_BELOW;
  const indent = isStacked ? 2 : 2 + LABEL;
  const mark = Text({ color, children: [`${glyph} `] });
  const detail = Box({ width: view.width - indent, children: [Text({ wrap: "wrap", children: [check.detail] })] });
  const lines = isStacked
    ? [
        Box({ flexDirection: "row", children: [mark, Text({ bold: true, children: [check.label] })] }),
        Box({ flexDirection: "row", children: [Text({ children: ["  "] }), detail] }),
      ]
    : [Box({ flexDirection: "row", children: [mark, Text({ children: [padEnd(check.label, LABEL)] }), detail] })];
  const fixRow = (which: Fix) =>
    Box({
      flexDirection: "row",
      children: [
        Text({ children: [" ".repeat(indent)] }),
        keyButton(view, FIXES[which].key, FIXES[which].label, () => doctor.fix(host, which)),
      ],
    });
  const children = check.fix === undefined ? lines : [...lines, fixRow(check.fix)];
  return Box({ key: `check-${check.id}`, flexDirection: "column", children });
}

function diffColor(line: string, index: number): { color?: (typeof COLORS)[keyof typeof COLORS]; dimColor?: boolean } {
  if (index < 2 || line.startsWith("@@")) return { dimColor: true };
  if (line.startsWith("+")) return { color: COLORS.ok };
  if (line.startsWith("-")) return { color: COLORS.fail };
  return {};
}

function appliedRows(view: View, applied: Applied): RenderElement[] {
  const { Text } = view.kit;
  const ellipsis = view.g.ellipsis;
  const lines = applied.diff.split("\n");
  const shown = lines.slice(0, DIFF_ROWS);
  const { glyph, color } = levelMark("ok", view.g);
  return [
    Text({ wrap: "wrap", children: [Text({ color, children: [`${glyph} `] }), `${FIXES[applied.fix].done} ${tildePath(applied.path, view.home)}`] }),
    Text({ dimColor: true, wrap: "wrap", children: [`  Backup: ${tildePath(applied.backupPath, view.home)}`] }),
    ...shown.map((line, index) =>
      Text({ ...diffColor(line, index), children: [`  ${fitEnd(line, view.width - 2, ellipsis)}`] }),
    ),
    ...(lines.length > shown.length
      ? [Text({ dimColor: true, children: [`  ${ellipsis} ${lines.length - shown.length} more diff lines`] })]
      : []),
  ];
}

export const view: TabView = async (host, view) => {
  const { Box, Text } = view.kit;
  const state = (await host.state.doctor.get()).value;
  const runKey = (label: string) => keyButton(view, KEYS.reload, label, () => doctor.run(host));
  const words = { loading: "Running the checks", empty: "The doctor checks have not run in this session." };
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
  return [
    Box({ key: "head", flexDirection: "row", columnGap: GAP, children: [button, Text({ dimColor: true, children: [fitEnd(status, room, view.g.ellipsis)] })] }),
    ...(state.error === null ? [] : [Text({ color: COLORS.fail, wrap: "wrap", children: [`${view.g.cross} ${state.error}`] })]),
    ...(state.applied === null ? [] : appliedRows(view, state.applied)),
    ...state.checks.toSorted((a, b) => SEVERITY[a.level] - SEVERITY[b.level]).map((check) => checkRow(host, view, check)),
  ];
};
