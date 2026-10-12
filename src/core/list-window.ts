export type ListSlice = { start: number; end: number };

/** A list drawn as a window: its length, the selected index, and the indices that take focus. */
export type FocusList = { total: number; current: number; rows: readonly number[] };

/** What the last drawing showed: its first index, its size, and the selection's focus ordinal. */
export type Drawn = { start: number; size: number; ordinal: number };

export type Placement = { start: number; isRefocusNeeded: boolean };

export type FocusMove = { kind: "wrap" } | { kind: "move"; landing: number; start: number };

export function windowOf(total: number, cursor: number, size: number): ListSlice {
  const span = Math.max(1, Math.min(size, total));
  const start = Math.max(0, Math.min(total - span, cursor - Math.floor(span / 2)));
  return { start, end: start + span };
}

function visible(list: FocusList, start: number, size: number): number[] {
  return list.rows.filter((index) => index >= start && index < start + size);
}

export function drawnAt(list: FocusList, start: number, size: number): Drawn {
  return { start, size, ordinal: visible(list, start, size).indexOf(list.current) };
}

// The engine keeps the focus ring at its focus-order position across redraws and redraws on
// its own, so the window is state: it moves where a focus move planned it, keeps its start
// at the same size, keeps the selection's ordinal across a size change, and centres on the
// selection only when it would otherwise leave the window. A drawing that moves the
// selection's ordinal leaves the ring on another row, so it asks for a refocus.
export function placeWindow(list: FocusList, size: number, last: Drawn | undefined, planned?: number): Placement {
  const centred = windowOf(list.total, list.current, size).start;
  const isInside = (start: number) => list.current >= start && list.current < start + size;
  if (planned !== undefined) return { start: isInside(planned) ? planned : centred, isRefocusNeeded: false };
  if (last === undefined || last.ordinal < 0) return { start: centred, isRefocusNeeded: false };
  const room = Math.max(0, list.total - size);
  const anchor = list.rows[list.rows.indexOf(list.current) - last.ordinal];
  const candidate = size === last.size ? Math.min(last.start, room) : Math.min(anchor ?? centred, room);
  const start = isInside(candidate) ? candidate : centred;
  return { start, isRefocusNeeded: drawnAt(list, start, size).ordinal !== last.ordinal };
}

// A move onto `picked` re-centres the window on it, so the ring is sent to the row drawn now
// at the ordinal `picked` will hold after the re-centre: positions count focusable rows only.
// A move from the last row onto the first drawn one, or the reverse, is the ring wrapping.
export function focusMove(list: FocusList, last: Drawn, picked: number): FocusMove {
  const before = visible(list, last.start, last.size);
  const next = windowOf(list.total, picked, last.size);
  const after = visible(list, next.start, last.size);
  const isWrap =
    before.length >= 3 &&
    ((list.current === list.rows.at(-1) && picked === before[0]) ||
      (list.current === list.rows[0] && picked === before.at(-1)));
  if (isWrap) return { kind: "wrap" };
  return { kind: "move", landing: before[after.indexOf(picked)] ?? picked, start: next.start };
}

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
