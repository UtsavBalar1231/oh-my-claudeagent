import type { RenderElement } from "claude-code";
import type { Fix } from "../../src/core/doctor-checks.ts";
import { lastStart, stepStart, windowEnd } from "../../src/core/list-window.ts";
import { tildePath } from "../../src/core/path.ts";
import { clockOf, displayWidth, fitEnd, KEYS, padEnd, wrapText } from "../../src/core/ui-kit.ts";
import { chip, fitPieces, levelMark, type Piece, piecesWidth, type ThemeKey, TONE_KEYS } from "../../src/core/visual.ts";
import * as doctor from "../doctor.ts";
import { fillPrompt, type Host, type State } from "../host.ts";
import type { Subcommand } from "../omca-router.ts";
import { blanks, edge, keyButton, noticeRow, open, type TabView, type View } from "../pane.ts";
import { Line } from "../ui.ts";

type Check = State["doctor"]["checks"][number];
type Applied = NonNullable<State["doctor"]["applied"]>;

const LABEL = 14;
const GAP = 3;
// The widest chip, `! WARN` padded in Unicode or bracketed in ASCII, and the space after it.
const CHIP = 9;
const WORDS: Readonly<Record<Check["level"], string>> = { ok: "OK", warn: "WARN", fail: "FAIL", info: "INFO" };
// One key per check that names a command to run; r and i are taken, and digits switch tabs.
const PROMPT_KEYS: Readonly<Record<string, string>> = { server: "m", style: "y", advisor: "a", statusline: "s" };
// Below this a detail column would be too narrow for the longest variable name it quotes.
const MIN_DETAIL = 50;
const DIFF_ROWS = 16;
const EDGE_ROWS = 2;
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
  const answer = await open(host, e, "doctor");
  await doctor.run(host);
  return answer;
};

function summary(checks: readonly Check[], g: View["g"]): Piece[] {
  return (["fail", "warn", "info", "ok"] as const)
    .map((level) => [level, checks.filter((check) => check.level === level).length] as const)
    .filter(([, count]) => count > 0)
    .flatMap(([level, count], index) => {
      const { glyph, color } = levelMark(level, g);
      return [...(index === 0 ? [] : [{ text: "  " }]), { text: glyph, color }, { text: ` ${count} ${level}` }];
    });
}

type Rows = { element: RenderElement; height: number };

function checkRows(host: Host, view: View, check: Check): Rows {
  const { Box, Button, Text } = view.kit;
  const { glyph } = levelMark(check.level, view.g);
  const isStacked = view.width - CHIP - LABEL < MIN_DETAIL;
  const indent = isStacked ? 2 : CHIP + LABEL;
  const badge = chip(`${glyph} ${WORDS[check.level]}`, check.level, view.isAscii);
  const lead: Piece[] = [badge, { text: " ".repeat(Math.max(1, CHIP - displayWidth(badge.text))) }];
  const detail = wrapText(check.detail, view.width - indent);
  const line = (pieces: readonly Piece[]) => Line(view.kit, pieces);
  const lines = isStacked
    ? [line([...lead, { text: check.label, bold: true }]), ...detail.map((text) => line([{ text: `  ${text}` }]))]
    : detail.map((text, index) =>
        line(index === 0 ? [...lead, { text: padEnd(check.label, LABEL), bold: true }, { text }] : [{ text: `${" ".repeat(indent)}${text}` }]),
      );
  const room = Math.max(1, view.width - indent - displayWidth("x: "));
  const { fix, prompt } = check;
  const actions = [
    ...(fix === undefined ? [] : [keyButton(view, FIXES[fix].key, FIXES[fix].label, () => doctor.fix(host, fix))]),
    ...(prompt === undefined
      ? []
      : [
          Button({
            key: `prompt-${check.id}`,
            ...(PROMPT_KEYS[check.id] === undefined ? {} : { hotkey: PROMPT_KEYS[check.id] }),
            label: fitEnd(`Use ${prompt}`, room, view.g.ellipsis),
            plain: true,
            onPress: view.press(() => fillPrompt(host, prompt)),
          }),
        ]),
  ];
  const children = [
    ...lines,
    ...actions.map((action, index) => Box({ key: `action-${check.id}-${index}`, flexDirection: "row", children: [Text({ children: [" ".repeat(indent)] }), action] })),
  ];
  return {
    element: Box({ key: `check-${check.id}`, flexDirection: "column", hover: { backgroundColor: TONE_KEYS.focus }, children }),
    height: children.length,
  };
}

function diffColor(line: string, index: number): { color?: ThemeKey; dimColor?: boolean } {
  if (index < 2 || line.startsWith("@@")) return { dimColor: true };
  if (line.startsWith("+")) return { color: TONE_KEYS.ok };
  if (line.startsWith("-")) return { color: TONE_KEYS.fail };
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
  const room = view.width - displayWidth(`${KEYS.reload}: Run again`) - GAP;
  const counts = summary(state.checks, view.g);
  const checked: Piece = { text: `  checked ${clockOf(state.ranAt)}`, color: TONE_KEYS.muted };
  const status: Piece[] = state.isRunning
    ? [{ text: `Running the checks${view.g.ellipsis}`, color: TONE_KEYS.muted }]
    : [...counts, ...(piecesWidth([...counts, checked]) <= room ? [checked] : [])];
  const error = state.error === null ? undefined : `${view.g.cross} ${state.error}`;
  const applied = state.applied === null ? undefined : appliedRows(view, state.applied);
  const head = [
    Box({ key: "head", flexDirection: "row", columnGap: GAP, children: [button, Line(view.kit, fitPieces(status, room, view.g.ellipsis))] }),
    ...(error === undefined ? [] : [Text({ color: TONE_KEYS.fail, wrap: "wrap", children: [error] })]),
    ...(applied?.elements ?? []),
  ];
  const headHeight = 1 + (error === undefined ? 0 : wrapText(error, view.width).length) + (applied?.height ?? 0);
  const checks = state.checks.toSorted((a, b) => SEVERITY[a.level] - SEVERITY[b.level]).map((check) => checkRows(host, view, check));
  const heights = checks.map(({ height }) => height);
  const space = view.rows - headHeight;
  if (heights.reduce((sum, height) => sum + height, 0) <= space) return [...head, ...checks.map(({ element }) => element)];
  const windowRows = Math.max(1, space - EDGE_ROWS);
  first = Math.min(first, lastStart(heights, windowRows));
  laid = { heights, room: windowRows };
  const capacity = first > 0 ? windowRows : Math.max(1, space - 1);
  const end = windowEnd(heights, first, capacity);
  const shown = heights.slice(first, end).reduce((sum, height) => sum + height, 0);
  // The engine raises ui.scroll only for a tree taller than the body, so this one row past the
  // window is what brings the arrows and the wheel to `scroll`.
  return [
    ...head,
    ...(first > 0 ? [edge(view, `  ${view.g.up} ${first} more`)] : []),
    ...checks.slice(first, end).map(({ element }) => element),
    ...blanks(view, capacity - shown),
    edge(view, end < checks.length ? `  ${view.g.down} ${checks.length - end} more ${view.g.dot} ${view.g.up}${view.g.down} scroll` : ""),
    ...blanks(view, 1),
  ];
};
