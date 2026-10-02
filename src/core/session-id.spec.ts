import { expect, test } from "bun:test";
import { isSafeSessionId } from "./session-id.ts";

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
])("isSafeSessionId(%p) is %p", (id, expected) => {
  expect(isSafeSessionId(id)).toBe(expected);
});
