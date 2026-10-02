import { describe, expect, test } from "bun:test";
import { drawnAt, type FocusList, focusMove, placeWindow } from "./list-window.ts";

const all = (total: number, current: number): FocusList => ({
  total,
  current,
  rows: Array.from({ length: total }, (_, i) => i),
});

// Headings at 0, 5 and 10 draw as text and take no focus.
const sections = (current: number): FocusList => ({ total: 15, current, rows: [1, 2, 3, 4, 6, 7, 8, 9, 11, 12, 13, 14] });

describe("placeWindow", () => {
  test("a first drawing centres on the selection, and a planned start wins while it holds the selection", () => {
    expect(placeWindow(all(20, 10), 5, undefined)).toEqual({ start: 8, isRefocusNeeded: false });
    expect(placeWindow(all(20, 10), 5, undefined, 9)).toEqual({ start: 9, isRefocusNeeded: false });
    expect(placeWindow(all(20, 10), 5, undefined, 2)).toEqual({ start: 8, isRefocusNeeded: false });
  });

  test("at the same size the window keeps its start while the selection stays inside", () => {
    expect(placeWindow(all(20, 10), 5, { start: 6, size: 5, ordinal: 4 })).toEqual({ start: 6, isRefocusNeeded: false });
  });

  test("a selection that left the window re-centres it and asks for a refocus", () => {
    expect(placeWindow(all(20, 10), 5, { start: 0, size: 5, ordinal: 0 })).toEqual({ start: 8, isRefocusNeeded: true });
  });

  test("a size change keeps the selection's focus ordinal, counting focusable rows only", () => {
    expect(placeWindow(all(20, 7), 9, { start: 4, size: 5, ordinal: 3 })).toEqual({ start: 4, isRefocusNeeded: false });
    const list = sections(8);
    expect(drawnAt(list, 4, 5)).toEqual({ start: 4, size: 5, ordinal: 3 });
    expect(placeWindow(list, 3, { start: 4, size: 5, ordinal: 3 })).toEqual({ start: 7, isRefocusNeeded: true });
    expect(placeWindow(list, 8, { start: 4, size: 5, ordinal: 3 })).toEqual({ start: 4, isRefocusNeeded: false });
  });

  test("a size change clamped at the end moves the ordinal and asks for a refocus", () => {
    expect(placeWindow(all(20, 18), 9, { start: 15, size: 5, ordinal: 3 })).toEqual({ start: 11, isRefocusNeeded: true });
  });
});

describe("focusMove", () => {
  test("a move down mid-list re-centres and sends the ring to the position the picked row takes", () => {
    expect(focusMove(all(20, 10), { start: 8, size: 5, ordinal: 2 }, 11)).toEqual({ kind: "move", landing: 10, start: 9 });
    expect(focusMove(all(20, 10), { start: 8, size: 5, ordinal: 2 }, 9)).toEqual({ kind: "move", landing: 10, start: 7 });
  });

  test("the landing counts focusable rows only, skipping headings drawn as text", () => {
    expect(focusMove(sections(7), { start: 4, size: 6, ordinal: 2 }, 8)).toEqual({ kind: "move", landing: 7, start: 5 });
    expect(focusMove(sections(9), { start: 6, size: 6, ordinal: 3 }, 11)).toEqual({ kind: "move", landing: 8, start: 8 });
  });

  test("near either end the window is clamped and the ring moves with the selection", () => {
    expect(focusMove(all(20, 17), { start: 15, size: 5, ordinal: 2 }, 18)).toEqual({ kind: "move", landing: 18, start: 15 });
    expect(focusMove(all(20, 1), { start: 0, size: 5, ordinal: 1 }, 0)).toEqual({ kind: "move", landing: 0, start: 0 });
  });

  test("the ring wrapping from the last row to the first drawn one, or back, is refused", () => {
    expect(focusMove(all(20, 19), { start: 15, size: 5, ordinal: 4 }, 15)).toEqual({ kind: "wrap" });
    expect(focusMove(all(20, 0), { start: 0, size: 5, ordinal: 0 }, 4)).toEqual({ kind: "wrap" });
    expect(focusMove(sections(14), { start: 9, size: 6, ordinal: 4 }, 9)).toEqual({ kind: "wrap" });
  });

  test("with fewer than three rows drawn a jump between the ends is an ordinary move", () => {
    expect(focusMove(all(2, 1), { start: 0, size: 5, ordinal: 1 }, 0)).toEqual({ kind: "move", landing: 0, start: 0 });
  });
});
