import { expect, test } from "bun:test";
import { isHookDisabled } from "./kill-switch.ts";

test("an unset or empty list disables nothing", () => {
  expect([isHookDisabled(undefined, "drift-guard"), isHookDisabled("", "drift-guard")]).toEqual([false, false]);
});

test("names separated by commas or whitespace each disable their hook", () => {
  expect(isHookDisabled("drift-guard,task-completed-verify", "task-completed-verify")).toBe(true);
  expect(isHookDisabled(" drift-guard  task-completed-verify ", "drift-guard")).toBe(true);
});

test("a name matches whole, never as a substring", () => {
  expect(isHookDisabled("task-completed-verify-old,verify", "task-completed-verify")).toBe(false);
});

test("all and * disable every hook", () => {
  expect([isHookDisabled("all", "drift-guard"), isHookDisabled("x,*", "drift-guard")]).toEqual([true, true]);
});
