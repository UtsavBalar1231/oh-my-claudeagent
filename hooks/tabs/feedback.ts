import type { RenderElement } from "claude-code";
import { COLORS, displayWidth, fitEnd, padEnd } from "../../src/core/ui-kit.ts";
import { type Rating, rate, shown, type Verdict } from "../feedback.ts";
import type { Host } from "../host.ts";
import { keyButton, noticeRow, type TabView, type View } from "../pane.ts";

const BUTTON_GAP = 2;
const VERDICT = 4;
const GAP = "  ";
const WORDS = { loading: "", empty: "No feedback has been recorded in this session." };

const two = (value: number) => String(value).padStart(2, "0");
const when = (at: string) => {
  const date = new Date(at);
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
};

function actions(host: Host, view: View, hasTurn: boolean): RenderElement {
  const press = (verdict: Verdict) => async () => {
    await rate(host, verdict, "");
    host.ui.invalidate();
  };
  const buttons = [keyButton(view, "u", "Up", press("up")), keyButton(view, "d", "Down", press("down"))];
  const hint = hasTurn ? "rate the last turn" : "rate the session (no turn yet)";
  const room = view.width - displayWidth("u: Up") - displayWidth("d: Down") - BUTTON_GAP * 2;
  return view.kit.Box({
    key: "actions",
    flexDirection: "row",
    columnGap: BUTTON_GAP,
    children: [...buttons, view.kit.Text({ dimColor: true, children: [fitEnd(hint, room, view.g.ellipsis)] })],
  });
}

function row(view: View, rating: Rating, index: number): RenderElement {
  const { Box, Text } = view.kit;
  const isUp = rating.rating === "up";
  const fixed = `${padEnd(rating.rating, VERDICT)}${GAP}${when(rating.at)}${GAP}`;
  const note = fitEnd(rating.note ?? "", view.width - 2 - displayWidth(fixed), view.g.ellipsis);
  return Box({
    key: `rating-${index}`,
    flexDirection: "row",
    children: [
      Text({ color: isUp ? COLORS.ok : COLORS.fail, children: [`${isUp ? view.g.up : view.g.down} `] }),
      Text({ children: [fixed] }),
      Text({ dimColor: true, children: [note] }),
    ],
  });
}

export const view: TabView = async (host, view) => {
  const { ratings, error, hasTurn } = shown();
  const head = [actions(host, view, hasTurn)];
  if (error !== null) return [...head, noticeRow(view, { kind: "error", reason: error }, WORDS)];
  if (ratings.length === 0) return [...head, noticeRow(view, { kind: "empty" }, WORDS)];
  const ups = ratings.filter((rating) => rating.rating === "up").length;
  const plural = ratings.length === 1 ? "rating" : "ratings";
  const summary = `${ratings.length} ${plural}, newest first ${view.g.dot} ${ups} up, ${ratings.length - ups} down`;
  const room = Math.max(1, view.rows - 2);
  const newest = [...ratings].reverse();
  const listed = newest.length > room ? newest.slice(0, room - 1) : newest;
  const { Text } = view.kit;
  return [
    ...head,
    Text({ dimColor: true, children: [fitEnd(summary, view.width, view.g.ellipsis)] }),
    ...listed.map((rating, index) => row(view, rating, index)),
    ...(listed.length < newest.length
      ? [Text({ dimColor: true, children: [`  ${view.g.down} ${newest.length - listed.length} more`] })]
      : []),
  ];
};
