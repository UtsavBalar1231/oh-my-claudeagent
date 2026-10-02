import { describe, expect, test } from "bun:test";
import { hasReference, isPlaceholderTodo } from "./todo.ts";

const MARKER = "TODO: imple" + "ment";

describe("isPlaceholderTodo", () => {
  test.each([
    [MARKER],
    [`${MARKER} this`],
    [`# ${MARKER} the parser`],
    [`${MARKER}ation`],
    [MARKER.toLowerCase()],
    [`first line\n${MARKER}\nlast line`],
  ])("%p is a placeholder", (text) => {
    expect(isPlaceholderTodo(text)).toBe(true);
  });

  test.each([
    [`${MARKER} the fallback path once the upstream exposes a retry budget`],
    [`${MARKER} #42`],
    [`${MARKER} PROJ-7`],
    [`${MARKER} @alice`],
    ["TODO: handle the retry"],
    ["implement the parser"],
    [""],
  ])("%p is not", (text) => {
    expect(isPlaceholderTodo(text)).toBe(false);
  });

  test("any placeholder line in a block counts, whatever an earlier marker explains", () => {
    expect(isPlaceholderTodo(`${MARKER} the fallback path once the upstream exposes a budget\n${MARKER}`)).toBe(true);
  });

  test("a reference elsewhere on the line clears it, but one on another line does not", () => {
    expect(isPlaceholderTodo(`PROJ-7 ${MARKER}`)).toBe(false);
    expect(isPlaceholderTodo(`PROJ-7\n${MARKER}`)).toBe(true);
  });
});

describe("hasReference", () => {
  test.each([["see #12", true], ["PROJ-34", true], ["@alice", true], ["plain words", false], ["lower-12", false]])("%p is %p", (text, expected) => {
    expect(hasReference(text)).toBe(expected);
  });
});
