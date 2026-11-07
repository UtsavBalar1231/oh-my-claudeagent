import { describe, expect, test } from "bun:test";
import { type NextAction, nextActions } from "./next-actions.ts";

const LOG: NextAction = { kind: "log-evidence", label: "Log evidence", prompt: "Log evidence for `just test` with evidence_log" };
const TASKS: NextAction = { kind: "task-list", label: "Task list", prompt: "/tasklist" };

describe("nextActions", () => {
  test("nothing run offers nothing", () => {
    expect(nextActions({ verification: null, isRunOpen: false })).toEqual([]);
  });

  test("an unlogged verification offers to log it", () => {
    expect(nextActions({ verification: { command: "just test", isLogged: false }, isRunOpen: false })).toEqual([LOG]);
  });

  test("a logged verification offers nothing", () => {
    expect(nextActions({ verification: { command: "just test", isLogged: true }, isRunOpen: false })).toEqual([]);
  });

  test("the fill text carries the command verbatim, backticks around it", () => {
    expect(nextActions({ verification: { command: "bun test src/a b.spec.ts", isLogged: false }, isRunOpen: false })).toEqual([
      { ...LOG, prompt: "Log evidence for `bun test src/a b.spec.ts` with evidence_log" },
    ]);
  });

  test("an open run offers the task list, after the log action", () => {
    expect(nextActions({ verification: null, isRunOpen: true })).toEqual([TASKS]);
    expect(nextActions({ verification: { command: "just test", isLogged: false }, isRunOpen: true })).toEqual([LOG, TASKS]);
  });
});
