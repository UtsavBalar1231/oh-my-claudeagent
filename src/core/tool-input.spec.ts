import { expect, test } from "bun:test";
import { field, inputText, isRecord, text } from "./tool-input.ts";

test.each([
  [{ file_path: "/a/b.ts" }, "/a/b.ts"],
  [{ file_path: 3 }, ""],
  [{ file_path: null }, ""],
  [{}, ""],
  [null, ""],
  [undefined, ""],
  ["file_path", ""],
])("inputText(%p, file_path) is %p", (input, expected) => {
  expect(inputText(input, "file_path")).toBe(expected);
});

test.each([
  [{}, true],
  [{ a: 1 }, true],
  [Object.create(null), true],
  [[], false],
  [[{}], false],
  [null, false],
  [undefined, false],
  ["text", false],
  [3, false],
])("isRecord(%p) is %p", (value, expected) => {
  expect(isRecord(value)).toBe(expected);
});

test("inputText reads nothing from an array", () => {
  expect(inputText(["a"], "0")).toBe("");
});

test.each([
  [{ a: 1 }, "a", 1],
  [{ a: null }, "a", null],
  [{ a: 1 }, "b", undefined],
  [["x"], "0", undefined],
  [null, "a", undefined],
  ["a", "length", undefined],
])("field(%p, %p) is %p", (value, key, expected) => {
  expect(field(value, key)).toBe(expected);
});

test.each([
  ["abc", "abc"],
  ["", ""],
  [3, ""],
  [null, ""],
  [undefined, ""],
  [["a"], ""],
])("text(%p) is %p", (value, expected) => {
  expect(text(value)).toBe(expected);
});
