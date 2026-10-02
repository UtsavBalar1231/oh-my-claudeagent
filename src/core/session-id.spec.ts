import { describe, expect, test } from "bun:test";
import { isSafeSessionId, isWindowsSafeName } from "./session-id.ts";

test.each<[string, boolean]>([
  ["00000000-0000-4000-8000-000000000001", true],
  ["a", true],
  ["A_b-9", true],
  ["a".repeat(128), true],
  ["a".repeat(129), false],
  ["", false],
  ["-leading-dash", false],
  ["_leading-underscore", false],
  ["../escape", false],
  ["a/b", false],
  ["a.json", false],
  ["a b", false],
  ["a\n", false],
  ["con", false],
  ["NUL", false],
  ["Com1", false],
  ["lpt9", false],
  ["console", true],
  ["com0", true],
  ["con-1", true],
])("isSafeSessionId(%p) is %p", (id, expected) => {
  expect(isSafeSessionId(id)).toBe(expected);
});

describe("isWindowsSafeName", () => {
  test.each(["CON", "con", "PRN", "Aux", "NUL", "COM1", "com9", "LPT1", "lpt9"])("%s is a device name", (name) => {
    expect(isWindowsSafeName(name)).toBe(false);
  });

  test.each(["con.txt", "NUL.md", "COM1.tar.gz", "aux.", "lpt3.log"])("%s is a device name with an extension or a trailing dot", (name) => {
    expect(isWindowsSafeName(name)).toBe(false);
  });

  test.each(["plan.", "a..", "."])("%s ends in a dot, which Windows drops", (name) => {
    expect(isWindowsSafeName(name)).toBe(false);
  });

  test.each(["console", "comment", "com0", "lpt10", "a.con", "con-x", "plan.md", "platform-2.1.278"])("%s is a usable name", (name) => {
    expect(isWindowsSafeName(name)).toBe(true);
  });
});
