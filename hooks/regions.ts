import type { RenderElement } from "claude-code";
import { chunks } from "../src/core/plan-reader.ts";
import { displayWidth, fitEnd, type Glyphs, padEnd, wrapText } from "../src/core/ui-kit.ts";
import { CodeBlock, type Kit } from "./ui.ts";

/**
 * One piece of a region's content and the rows it takes: exact where the tab lays it out, counted
 * high where the engine does, since a count too low leaves the end out of reach.
 */
export type Unit = { element: RenderElement; rows: number };

/** Where a region sits in its tab's own rows and columns. */
export type Region = { key: string; left: number; top: number; width: number; height: number };

// Each region's offset, in units, outlives a drawing; the regions laid out are the latest drawing's only.
const offsets = new Map<string, number>();
let laid: (Region & { max: number })[] = [];
let aimed: string | undefined;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** Forgets the regions of the last drawing; a drawing lays out its own again. */
export function resetRegions(): void {
  laid = [];
}

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
  const region = laid.find((one) => one.key === aimed && one.max > 0) ?? laid.find((one) => one.max > 0);
  if (region === undefined) return false;
  const move = step === "row" ? by : step === "page" ? Math.sign(by) * Math.max(1, region.height - 1) : Math.sign(by) * region.max;
  offsets.set(region.key, clamp((offsets.get(region.key) ?? 0) + move, 0, region.max));
  return true;
}

/** Whether a region of the latest drawing holds more than it shows, so the wheel must reach it. */
export const hasOverflow = (): boolean => laid.some((region) => region.max > 0);

/**
 * Moves the region under the pointer by `by` units; false when no region is there. A region at its
 * end still takes the tick, so the wheel over it never scrolls what is around it.
 */
export function scrollRegionAt(pointer: { column: number; row: number }, by: number): boolean {
  const region = laid.find(
    ({ left, top, width, height }) => pointer.column >= left && pointer.column < left + width && pointer.row >= top && pointer.row < top + height,
  );
  if (region === undefined) return false;
  offsets.set(region.key, clamp((offsets.get(region.key) ?? 0) + by, 0, region.max));
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

type Spec = Region & { kit: Kit; g: Glyphs; units: readonly Unit[] };

/**
 * At most `height` rows of `units`, from the region's offset down, with a dim cue row above while
 * units sit above and one below while more follow. The window draws the units it shows and nothing
 * else: an element placed above the body's top row is clamped there, so no part of it is moved off.
 */
export function ScrollRegion({ kit, g, units, ...region }: Spec): RenderElement {
  const { key, width } = region;
  const height = Math.max(1, region.height);
  const isCued = height >= CUED_FROM;
  const max = lastOffset(units, height, isCued);
  laid.push({ ...region, height, max });
  const offset = Math.min(offsets.get(key) ?? 0, max);
  const isAbove = isCued && offset > 0;
  const room = height - (isAbove ? 1 : 0);
  const rest = units.slice(offset);
  const isOver = rest.reduce((sum, unit) => sum + unit.rows, 0) > room;
  const isBelow = isCued && isOver;
  const shown: RenderElement[] = [];
  for (let used = 0, at = 0; at < rest.length && used < room; at += 1) {
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
        ...(isOver ? { height: room - (isBelow ? 1 : 0) } : {}),
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

/** Code wrapped to `width`, each row its own block, so a region scrolls it a row at a time. */
export function codeUnits(kit: Kit, text: string, width: number, language?: string): Unit[] {
  return text
    .replace(/\s+$/, "")
    .split("\n")
    .flatMap((line) => wrapLine(line.replaceAll("\t", "  "), width))
    .map((source) => ({ element: CodeBlock(kit, { source, ...(language === undefined ? {} : { language }) }), rows: 1 }));
}

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/;
const TABLE = /^\s*\|/;
const LIST = /^\s*(?:[-*+]|\d+[.)])\s/;
const HEADING = /^\s*#{1,6}\s/;

/**
 * Markdown cut into units a region can window: each source line drawn on its own by the engine's
 * renderer, a fenced block as code a row at a time, a table whole. A line's rows are its source
 * words wrapped inside a list item's hanging indent, which errs high where the markers drop out,
 * plus the row under a heading; a table's are two a line.
 */
export function markdownUnits(kit: Kit, text: string, width: number, key: string): Unit[] {
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
      const room = width - (LIST.test(line) ? 2 : 0);
      markdown(line, at, (part) => wrapText(part, room).length + (HEADING.test(line) ? 1 : 0));
    }
  }
  return units;
}
