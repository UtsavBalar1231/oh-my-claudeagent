import type { RenderElement } from "claude-code";
import { displayWidth, fitEnd, formatWhen, wrapText } from "../../src/core/ui-kit.ts";
import { chip, type Piece, piecesWidth, redact, TONE_KEYS } from "../../src/core/visual.ts";
import type { Input } from "../dispatch.ts";
import { type Rating, rate, shown, type Verdict } from "../feedback.ts";
import type { Host } from "../host.ts";
import { blanks, keyButton, noticeRow, type TabView, type View } from "../pane.ts";
import { Card, Row } from "../ui.ts";

const BUTTON_GAP = 2;
const GAP = "  ";
// The wider verdict chip, ` ↓ DOWN `, and the space after it.
const CHIP = 9;
const CARD_FRAME = 4;
// The card's top border, title and bottom border.
const CARD_ROWS = 3;
// The most rows one note takes while every rating fits.
const NOTE_ROWS = 3;
const WORDS = { loading: "", empty: "No feedback has been recorded in this session." };

// The newest rating in view, and the latest drawing's last such rating while some are hidden; none otherwise.
let first = 0;
let laid: { max: number } | undefined;

/** A wheel tick moves the newest rating in view; false while every rating shows. */
export function scroll(host: Host, e: Input<"ui.scroll">): boolean {
  if (laid === undefined) return false;
  first = Math.min(laid.max, Math.max(0, first + e.by));
  host.ui.invalidate();
  return true;
}

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

function lead(view: View, rating: Rating): Piece[] {
  const isUp = rating.rating === "up";
  const badge = chip(`${isUp ? view.g.up : view.g.down} ${isUp ? "UP" : "DOWN"}`, isUp ? "ok" : "fail", view.isAscii);
  return [badge, { text: " ".repeat(CHIP - displayWidth(badge.text)) }, { text: `${formatWhen(rating.at)}${GAP}`, color: TONE_KEYS.muted }];
}

// The note in at most `maxRows` rows of `room` cells, the last ending in an ellipsis when it was cut.
function noteLines(view: View, rating: Rating, room: number, maxRows: number): string[] {
  const text = redact(rating.note ?? "", view.home, view.g.mask).text;
  if (displayWidth(text) <= room) return [text];
  const lines = wrapText(text, room);
  if (lines.length <= maxRows) return lines;
  return [...lines.slice(0, maxRows - 1), fitEnd(lines.slice(maxRows - 1).join(" "), room, view.g.ellipsis)];
}

type Item = { index: number; lead: Piece[]; note: string[] };

function rows(view: View, { index, lead, note }: Item): RenderElement[] {
  const indent = { text: " ".repeat(piecesWidth(lead)) };
  return note.map((text, line) =>
    Row(view.kit, {
      key: line === 0 ? `rating-${index}` : `rating-${index}-${line}`,
      pieces: [...(line === 0 ? lead : [indent]), ...(text === "" ? [] : [{ text }])],
    }),
  );
}

export const view: TabView = async (host, view) => {
  const { ratings, error, hasTurn } = shown();
  const head = [actions(host, view, hasTurn)];
  laid = undefined;
  if (error !== null) return [...head, noticeRow(view, { kind: "error", reason: error }, WORDS)];
  if (ratings.length === 0) return [...head, noticeRow(view, { kind: "empty" }, WORDS)];
  const ups = ratings.filter((rating) => rating.rating === "up").length;
  const downs = ratings.length - ups;
  const inner = view.width - CARD_FRAME;
  const title = `${ratings.length} ${ratings.length === 1 ? "rating" : "ratings"}, newest first ${view.g.dot} ${view.g.up} ${ups} up ${view.g.dot} ${view.g.down} ${downs} down`;
  const budget = view.rows - head.length - CARD_ROWS;
  const newest = [...ratings].reverse();
  const itemsAt = (maxRows: number): Item[] =>
    newest.map((rating, index) => {
      const marks = lead(view, rating);
      return { index, lead: marks, note: noteLines(view, rating, inner - piecesWidth(marks), maxRows) };
    });
  const wrapped = itemsAt(NOTE_ROWS);
  const items = wrapped.reduce((sum, item) => sum + item.note.length, 0) <= budget ? wrapped : itemsAt(1);
  const card = (children: readonly RenderElement[]) =>
    Card(view.kit, {
      key: "ratings",
      title: fitEnd(title, inner, view.g.ellipsis),
      tone: downs > 0 ? "warn" : "ok",
      isAscii: view.isAscii,
      width: view.width,
      children,
    });
  const isCut = items.length > budget;
  if (isCut && budget < 2) return [...head, card([])];
  const max = isCut ? items.length - budget + 1 : 0;
  first = Math.min(first, max);
  const top = first > 0 ? 1 : 0;
  const space = budget - top;
  const end = items.length - first <= space ? items.length : first + Math.max(1, space - 1);
  const bottom = end < items.length && space > 1 ? 1 : 0;
  laid = isCut ? { max } : undefined;
  const cue = (text: string) => view.kit.Text({ dimColor: true, children: [text] });
  return [
    ...head,
    card([
      ...(top === 1 ? [cue(`${view.g.up} ${first} more`)] : []),
      ...items.slice(first, end).flatMap((item) => rows(view, item)),
      ...(bottom === 1 ? [cue(`${view.g.down} ${items.length - end} more`)] : []),
    ]),
    ...(isCut ? blanks(view, 1) : []),
  ];
};
