import type { RenderElement } from "claude-code";
import { displayWidth, fitEnd, formatWhen } from "../../src/core/ui-kit.ts";
import { chip, type Piece, redact, TONE_KEYS } from "../../src/core/visual.ts";
import { type Rating, rate, shown, type Verdict } from "../feedback.ts";
import type { Host } from "../host.ts";
import { keyButton, noticeRow, type TabView, type View } from "../pane.ts";
import { Card, Row } from "../ui.ts";

const BUTTON_GAP = 2;
const GAP = "  ";
// The wider verdict chip, ` ↓ DOWN `, and the space after it.
const CHIP = 9;
const CARD_FRAME = 4;
// The card's top border, title and bottom border.
const CARD_ROWS = 3;
const WORDS = { loading: "", empty: "No feedback has been recorded in this session." };

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

function row(view: View, rating: Rating, index: number, inner: number): RenderElement {
  const isUp = rating.rating === "up";
  const badge = chip(`${isUp ? view.g.up : view.g.down} ${isUp ? "UP" : "DOWN"}`, isUp ? "ok" : "fail", view.isAscii);
  const when = `${formatWhen(rating.at)}${GAP}`;
  const room = inner - CHIP - displayWidth(when);
  const note = fitEnd(redact(rating.note ?? "", view.home, view.g.mask).text, room, view.g.ellipsis);
  const pieces: Piece[] = [
    badge,
    { text: " ".repeat(CHIP - displayWidth(badge.text)) },
    { text: when, color: TONE_KEYS.muted },
    ...(note === "" ? [] : [{ text: note }]),
  ];
  return Row(view.kit, { key: `rating-${index}`, pieces });
}

export const view: TabView = async (host, view) => {
  const { ratings, error, hasTurn } = shown();
  const head = [actions(host, view, hasTurn)];
  if (error !== null) return [...head, noticeRow(view, { kind: "error", reason: error }, WORDS)];
  if (ratings.length === 0) return [...head, noticeRow(view, { kind: "empty" }, WORDS)];
  const ups = ratings.filter((rating) => rating.rating === "up").length;
  const downs = ratings.length - ups;
  const inner = view.width - CARD_FRAME;
  const title = `${ratings.length} ${ratings.length === 1 ? "rating" : "ratings"}, newest first ${view.g.dot} ${view.g.up} ${ups} up ${view.g.dot} ${view.g.down} ${downs} down`;
  const room = Math.max(1, view.rows - head.length - CARD_ROWS);
  const newest = [...ratings].reverse();
  const listed = newest.length > room ? newest.slice(0, Math.max(1, room - 1)) : newest;
  return [
    ...head,
    Card(view.kit, {
      key: "ratings",
      title: fitEnd(title, inner, view.g.ellipsis),
      tone: downs > 0 ? "warn" : "ok",
      isAscii: view.isAscii,
      width: view.width,
      children: [
        ...listed.map((rating, index) => row(view, rating, index, inner)),
        ...(listed.length < newest.length
          ? [view.kit.Text({ dimColor: true, children: [`${view.g.down} ${newest.length - listed.length} more`] })]
          : []),
      ],
    }),
  ];
};
