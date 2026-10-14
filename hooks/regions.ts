import type { RenderElement } from "claude-code";
import { inlineMarkdown } from "../src/core/markdown.ts";
import { chunks } from "../src/core/plan-reader.ts";
import { displayWidth, fitEnd, type Glyphs, padEnd } from "../src/core/ui-kit.ts";
import { wrapPieces } from "../src/core/visual.ts";
import { CodeBlock, isRemote, type Kit, Line } from "./ui.ts";

/**
 * One piece of a region's content and the rows it takes: exact where the tab lays it out, counted
 * high where the engine does, since a count too low leaves the end out of reach.
 */
export type Unit = { element: RenderElement; rows: number };

/** Where a region sits in its tab's own rows and columns. */
export type Region = { key: string; left: number; top: number; width: number; height: number };

type Rect = Omit<Region, "key">;
type Cell = { column: number; row: number };

/** A list that draws its own window: the wheel over its rows moves it `by` rows. */
export type Pinned = Rect & { move: (by: number) => unknown };

/**
 * What one terminal drawing laid out: its regions and lists in the tab's rows and columns, the
 * pane's rows above the tab, the engine's offset it drew at, whether the pane padded the tree past
 * the body only for a region's sake, and the rows the tree takes at least.
 */
export type Layout = {
  seq: number;
  regions: (Region & { max: number })[];
  lists: Pinned[];
  chromeRows: number;
  shownOffset: number;
  isPadded: boolean;
  treeRows: number;
};

// Each region's offset, in units, outlives a drawing; the layout is the latest committed drawing's only.
const offsets = new Map<string, number>();
let drawings = 0;
let committed: Layout = { seq: 0, regions: [], lists: [], chromeRows: 0, shownOffset: 0, isPadded: false, treeRows: 0 };
let aimed: string | undefined;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** A drawing's own layout, numbered in the order the drawings start. */
export function newLayout(chromeRows: number, shownOffset: number): Layout {
  drawings += 1;
  return { seq: drawings, regions: [], lists: [], chromeRows, shownOffset, isPadded: false, treeRows: 0 };
}

/**
 * Makes a finished drawing's layout the one scrolling reads, in one assignment. The engine renders
 * and scrolls concurrently and a drawing awaits its tab, so a drawing that started earlier and
 * finishes later never replaces a newer one.
 */
export function commitLayout(layout: Layout): void {
  if (layout.seq > committed.seq) committed = layout;
}

export const committedLayout = (): Layout => committed;

/** Puts a region back at its top, as when what it shows changes. */
export function resetOffset(key: string): void {
  offsets.delete(key);
}

/** Names the region the scroll keys move, as when its card takes the ring; none moves the first that overflows. */
export function aimKeys(key: string | undefined): void {
  aimed = key;
}

/**
 * Moves the aimed region, or the first that holds more than it shows, by a row, by its height less
 * one, or to an end; false when no region overflows.
 */
export function scrollKeyed(by: number, step: "row" | "page" | "end"): boolean {
  const { regions } = committed;
  const region = regions.find((one) => one.key === aimed && one.max > 0) ?? regions.find((one) => one.max > 0);
  if (region === undefined) return false;
  const move = step === "row" ? by : step === "page" ? Math.sign(by) * Math.max(1, region.height - 1) : Math.sign(by) * region.max;
  offsets.set(region.key, clamp((offsets.get(region.key) ?? 0) + move, 0, region.max));
  return true;
}

/** Whether a region of a drawing holds more than it shows, so the wheel must reach it. */
export const hasOverflow = (layout: Layout): boolean => layout.regions.some((region) => region.max > 0);

const isIn = ({ left, top, width, height }: Rect, { column, row }: Cell) => column >= left && column < left + width && row >= top && row < top + height;

/**
 * Moves what the wheel is over in `layout` by `by` rows, a region before the list it sits in; false
 * over neither. `pointer` is the body's cell as shown. Either takes the tick at its end too, so the
 * wheel over it never moves what is around it.
 */
export async function scrollAt(layout: Layout, pointer: Cell, by: number): Promise<boolean> {
  const cell = { column: pointer.column, row: pointer.row + layout.shownOffset - layout.chromeRows };
  const region = layout.regions.find((one) => isIn(one, cell));
  if (region !== undefined) {
    offsets.set(region.key, clamp((offsets.get(region.key) ?? 0) + by, 0, region.max));
    return true;
  }
  const list = layout.lists.find((one) => isIn(one, cell));
  if (list === undefined) return false;
  await list.move(by);
  return true;
}

// The first unit from which the rest fits under the cue above it, so the window stops at its end;
// the last unit when even that one runs past.
function lastOffset(units: readonly Unit[], height: number, isCued: boolean): number {
  let rows = 0;
  let max = units.length - 1;
  for (let at = units.length - 1; at >= 0; at -= 1) {
    rows += units[at]?.rows ?? 0;
    if (rows > height - (isCued && at > 0 ? 1 : 0)) break;
    max = at;
  }
  return Math.max(0, max);
}

// A cue row above, one below and a row of content between them.
const CUED_FROM = 3;

type Spec = Region & { kit: Kit; g: Glyphs; units: readonly Unit[]; layout: Layout };

/**
 * At most `height` rows of `units`, from the region's offset down, with a dim cue row above while
 * units sit above and one below while more follow, laid out in the drawing's `layout`. The window
 * draws the units it shows and nothing else: an element placed above the body's top row is clamped
 * there, so no part of it is moved off.
 */
export function ScrollRegion({ kit, g, units, layout, ...region }: Spec): RenderElement {
  const { key, width } = region;
  if (isRemote(kit)) return kit.Box({ key, width, flexDirection: "column", children: units.map((unit) => unit.element) });
  const height = Math.max(1, region.height);
  const isCued = height >= CUED_FROM;
  const max = lastOffset(units, height, isCued);
  layout.regions.push({ ...region, height, max });
  const offset = Math.min(offsets.get(key) ?? 0, max);
  const isAbove = isCued && offset > 0;
  const room = height - (isAbove ? 1 : 0);
  const rest = units.slice(offset);
  const isOver = rest.reduce((sum, unit) => sum + unit.rows, 0) > room;
  const isBelow = isCued && isOver;
  const inner = room - (isBelow ? 1 : 0);
  // Units stop at the window's own rows, so only a unit taller than a row runs under the clip; the
  // engine counts clipped rows into the content it scrolls, and a row hidden under the cue below
  // would make a tab that fits read as taller than the pane.
  const shown: RenderElement[] = [];
  for (let used = 0, at = 0; at < rest.length && used < inner; at += 1) {
    const unit = rest[at];
    if (unit === undefined) break;
    shown.push(unit.element);
    used += unit.rows;
  }
  const cue = (text: string) => kit.Text({ dimColor: true, children: [padEnd(fitEnd(text, width, g.ellipsis), width)] });
  return kit.Box({
    key,
    width,
    flexDirection: "column",
    ...(max > 0 ? { height } : {}),
    children: [
      ...(isAbove ? [cue(`${g.up} ${offset} more`)] : []),
      // The units sit in a box that keeps its full height, so the clip cuts the last one rather than
      // the layout shrinking one of them to nothing.
      kit.Box({
        width,
        flexDirection: "column",
        overflow: "hidden",
        ...(isOver ? { height: inner } : {}),
        children: [kit.Box({ width, flexDirection: "column", flexShrink: 0, children: shown })],
      }),
      ...(isBelow ? [cue(`${g.down} more ${g.dot} wheel to scroll`)] : []),
    ],
  });
}

// A line cut into rows of at most `room` cells at its last space, or mid-word where a word is
// longer than a row, so wrapped code keeps every character.
function wrapLine(line: string, room: number): string[] {
  const rows: string[] = [];
  let rest = line;
  while (displayWidth(rest) > room) {
    const head = fitEnd(rest, room, "");
    const space = head.lastIndexOf(" ");
    const cut = space > 0 ? space + 1 : Math.max(1, head.length);
    rows.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut);
  }
  return [...rows, rest];
}

/**
 * Code wrapped to `width`, each row its own block, so a region scrolls it a row at a time; one block
 * a remote surface wraps itself, where every block draws its own frame and copy control.
 */
export function codeUnits(kit: Kit, text: string, width: number, language?: string): Unit[] {
  const source = text.replace(/\s+$/, "");
  const tagged = language === undefined ? {} : { language };
  if (isRemote(kit)) return [{ element: CodeBlock(kit, { source, ...tagged }), rows: source.split("\n").length }];
  return source
    .split("\n")
    .flatMap((line) => wrapLine(line.replaceAll("\t", "  "), width))
    .map((row) => ({ element: CodeBlock(kit, { source: row, ...tagged }), rows: 1 }));
}

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/;
const TABLE = /^\s*\|/;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
// Deeper nesting than this keeps this indent, so a nested item still leaves room for its words.
const MAX_INDENT = 8;

// A prose line wrapped to the width a row a unit, so a region scrolls a long paragraph a row at a
// time and every row it counts is a row drawn. A list item keeps its marker as written and hangs
// its later rows under its words, as the engine's own markdown does.
function proseUnits(kit: Kit, line: string, width: number): Unit[] {
  const item = ITEM.exec(line.replaceAll("\t", "  "));
  const lead = item === null ? "" : `${(item[1] ?? "").slice(0, MAX_INDENT)}${item[2] ?? "-"} `;
  const hang = displayWidth(lead);
  const rows = wrapPieces(inlineMarkdown(item === null ? line : (item[3] ?? "")), Math.max(1, width - hang));
  return rows.map((row, index) => ({ element: Line(kit, hang === 0 ? row : [{ text: index === 0 ? lead : " ".repeat(hang) }, ...row]), rows: 1 }));
}

/**
 * Markdown cut into units a region can window: prose a row at a time, a fenced block as code a row
 * at a time, and a table whole through the engine's renderer, counted at two rows a line.
 */
export function markdownUnits(kit: Kit, text: string, width: number, key: string): Unit[] {
  // A remote surface lays markdown out itself, in one element however long the text, where a row a
  // unit would spend three nodes a line of the few thousand it accepts.
  if (isRemote(kit)) return text.trim() === "" ? [] : [{ element: kit.Markdown({ key, text }), rows: text.split("\n").length }];
  const units: Unit[] = [];
  const lines = text.split("\n");
  const markdown = (source: string, at: number, rowsOf: (part: string) => number) =>
    chunks(source).forEach((part, index) => units.push({ element: kit.Markdown({ key: `${key}-${at}-${index}`, text: part }), rows: rowsOf(part) }));
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] ?? "";
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = fence[1] ?? "```";
      const close = lines.findIndex((next, index) => index > at && next.trim().startsWith(marker));
      const end = close === -1 ? lines.length : close;
      units.push(...codeUnits(kit, lines.slice(at + 1, end).join("\n"), width, fence[2] === "" ? undefined : fence[2]));
      at = end;
    } else if (TABLE.test(line)) {
      let end = at;
      while (TABLE.test(lines[end + 1] ?? "")) end += 1;
      markdown(lines.slice(at, end + 1).join("\n"), at, (part) => 2 * part.split("\n").length + 1);
      at = end;
    } else if (line.trim() === "") {
      units.push({ element: kit.Text({ children: [" "] }), rows: 1 });
    } else {
      units.push(...proseUnits(kit, line, width));
    }
  }
  return units;
}
