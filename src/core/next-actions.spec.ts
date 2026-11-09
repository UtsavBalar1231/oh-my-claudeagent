import { describe, expect, test } from "bun:test";
import { nextActions } from "./next-actions.ts";

describe("nextActions", () => {
  test("no open run offers nothing", () => {
    expect(nextActions({ isRunOpen: false })).toEqual([]);
  });

  test("an open run offers the task list", () => {
    expect(nextActions({ isRunOpen: true })).toEqual([{ kind: "task-list", label: "Task list", prompt: "/tasklist" }]);
  });
});
