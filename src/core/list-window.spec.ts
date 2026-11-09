import { describe, expect, test } from "bun:test";
import { lastStart, stepStart, windowEnd } from "./list-window.ts";

describe("windows over items of unequal height", () => {
  const heights = [2, 1, 3, 2, 1, 2];

  test("a window takes whole items while they fit, and at least one", () => {
    expect(windowEnd(heights, 0, 5)).toBe(2);
    expect(windowEnd(heights, 2, 5)).toBe(4);
    expect(windowEnd(heights, 2, 2)).toBe(3);
    expect(windowEnd(heights, 5, 9)).toBe(6);
  });

  test("the last start is the first one whose window reaches the end of the list", () => {
    expect(lastStart(heights, 5)).toBe(3);
    expect(lastStart(heights, 3)).toBe(4);
    expect(lastStart(heights, 1), "a last item taller than the room still shows").toBe(5);
    expect(lastStart(heights, 20)).toBe(0);
    expect(lastStart([], 5)).toBe(0);
  });

  test("a step moves by whole items until the rows asked for have passed, and stops at both ends", () => {
    expect(stepStart(heights, 0, 1, 5)).toBe(1);
    expect(stepStart(heights, 0, 3, 5)).toBe(2);
    expect(stepStart(heights, 0, 100, 5)).toBe(3);
    expect(stepStart(heights, 3, -1, 5)).toBe(2);
    expect(stepStart(heights, 3, -100, 5)).toBe(0);
    expect(stepStart(heights, 1, 0, 5)).toBe(1);
    expect(stepStart(heights, 5, 1, 5), "a start past the last is held to it").toBe(3);
  });
});
