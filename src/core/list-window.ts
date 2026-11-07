/**
 * Items of unequal height, windowed by whole items. `room` is the rows the window may fill, and
 * a window always holds at least one item, however tall.
 */
export function windowEnd(heights: readonly number[], start: number, room: number): number {
  let used = 0;
  let end = start;
  while (end < heights.length && (end === start || used + (heights[end] ?? 0) <= room)) {
    used += heights[end] ?? 0;
    end += 1;
  }
  return end;
}

/** The last start that still fills the window to the end of the list. */
export function lastStart(heights: readonly number[], room: number): number {
  let start = heights.length;
  let used = 0;
  while (start > 0 && used + (heights[start - 1] ?? 0) <= room) {
    start -= 1;
    used += heights[start] ?? 0;
  }
  return Math.max(0, Math.min(start, heights.length - 1));
}

/** Moves the start by whole items until at least `by` rows have passed, signed like a scroll. */
export function stepStart(heights: readonly number[], start: number, by: number, room: number): number {
  const last = lastStart(heights, room);
  let at = Math.min(start, last);
  let moved = 0;
  while (by > 0 && at < last && moved < by) {
    moved += heights[at] ?? 1;
    at += 1;
  }
  while (by < 0 && at > 0 && moved < -by) {
    at -= 1;
    moved += heights[at] ?? 1;
  }
  return at;
}
