import { expect, test } from "bun:test";
import { inputText } from "./tool-input.ts";

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
