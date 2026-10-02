import { expect, test } from "bun:test";
import { isHookDisabled } from "./kill-switch.ts";

test("an unset or empty list disables nothing", () => {
  expect([isHookDisabled(undefined, "bash-guard"), isHookDisabled("", "bash-guard")]).toEqual([false, false]);
});

test("names separated by commas or whitespace each disable their hook", () => {
  expect(isHookDisabled("bash-guard,task-completed", "task-completed")).toBe(true);
  expect(isHookDisabled(" bash-guard  task-completed ", "bash-guard")).toBe(true);
});

test("a name matches whole, never as a substring", () => {
  expect(isHookDisabled("task-completed-old,completed", "task-completed")).toBe(false);
});

test("all and * disable every hook", () => {
  expect([isHookDisabled("all", "bash-guard"), isHookDisabled("x,*", "bash-guard")]).toEqual([true, true]);
});
