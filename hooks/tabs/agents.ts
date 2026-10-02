import type { RenderElement } from "claude-code";
import { COLORS, displayWidth, fitEnd, formatDuration, formatTokens, levelMark, padEnd, padStart } from "../../src/core/ui-kit.ts";
import type { State } from "../host.ts";
import { noticeRow, type TabView, type View } from "../pane.ts";

type Row = State["agents"][string];

const MODEL = 12;
const EFFORT = 6;
const TIME = 6;
const TOKENS = 6;
const GAP = "  ";
const MIN_NAME = 10;
const MIN_DESCRIPTION = 6;

const shortType = (type: string) => type.slice(type.lastIndexOf(":") + 1);
const shortModel = (model: string) => model.replace(/^claude-/, "").replace(/-\d{8}$/, "");

function mark(row: Row, view: View): { glyph: string; color: string } {
  switch (row.status) {
    case "running":
      return { glyph: view.g.running, color: COLORS.accent };
    case "answer":
      return levelMark("ok", view.g);
    case "aborted":
    case "refusal":
      return levelMark("warn", view.g);
    case "error":
      return levelMark("fail", view.g);
    case "gone":
      return { glyph: view.g.pending, color: COLORS.muted };
  }
}

const isNewer = (a: Row, b: Row) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt);

export const view: TabView = async (host, view) => {
  const rows = Object.entries((await host.state.agents.get()).value ?? {}).sort(
    ([, a], [, b]) => Number(a.endedAt !== null) - Number(b.endedAt !== null) || isNewer(a, b),
  );
  const { Box, Text } = view.kit;
  if (rows.length === 0) {
    return [noticeRow(view, { kind: "empty" }, { loading: "", empty: "No subagent has run in this session yet." })];
  }
  const fixed = 2 + GAP.length * 3 + EFFORT + TIME + TOKENS;
  const hasModel = view.width - fixed - GAP.length - MODEL >= MIN_NAME;
  const nameWidth = Math.max(1, view.width - fixed - (hasModel ? GAP.length + MODEL : 0));
  const columns = (model: string, effort: string, time: string, tokens: string) =>
    [
      ...(hasModel ? [padEnd(fitEnd(model, MODEL, view.g.ellipsis), MODEL)] : []),
      padEnd(effort, EFFORT),
      padStart(time, TIME),
      padStart(tokens, TOKENS),
    ].join(GAP);
  const running = rows.filter(([, row]) => row.endedAt === null).length;
  const summary = `${running} running ${view.g.dot} ${rows.length - running} finished`;
  const line = ([id, row]: readonly [string, Row]): RenderElement => {
    const { glyph, color } = mark(row, view);
    const isDone = row.endedAt !== null;
    const name = fitEnd(shortType(row.type), nameWidth, view.g.ellipsis);
    const room = nameWidth - displayWidth(name);
    const about =
      row.description === "" || room < MIN_DESCRIPTION
        ? ""
        : fitEnd(` ${view.g.dot} ${row.description}`, room, view.g.ellipsis);
    const effort = row.effort === null ? view.g.dot : String(row.effort);
    const time = formatDuration((row.endedAt ?? view.now) - row.startedAt);
    const tokens = formatTokens(row.inputTokens + row.outputTokens);
    return Box({
      key: `agent-${id}`,
      flexDirection: "row",
      children: [
        Text({ color, children: [`${glyph} `] }),
        Text({ ...(isDone ? { dimColor: true } : { bold: true }), children: [name] }),
        Text({ dimColor: true, children: [padEnd(about, room)] }),
        Text({ ...(isDone ? { dimColor: true } : {}), children: [`${GAP}${columns(shortModel(row.model), effort, time, tokens)}`] }),
      ],
    });
  };
  return [
    Text({ dimColor: true, children: [fitEnd(summary, view.width, view.g.ellipsis)] }),
    Text({ dimColor: true, children: [`  ${padEnd("agent", nameWidth)}${GAP}${columns("model", "effort", "time", "tokens")}`] }),
    ...rows.map(line),
  ];
};
