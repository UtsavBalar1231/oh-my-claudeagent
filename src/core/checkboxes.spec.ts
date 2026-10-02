import { describe, expect, test } from "bun:test";
import { checkboxStates, MAX_LABEL_LEN, nextTaskLabel, planIsComplete } from "./checkboxes.ts";

describe("checkboxStates", () => {
  test("lists numbered checkboxes in order and ignores unnumbered ones", () => {
    const plan =
      "# Plan\n\n- [x] 1. Numbered done\n- [ ] 2. Numbered pending\n- [x] Review docs\n- [ ] Notify\n";
    expect(checkboxStates(plan)).toEqual(["x", " "]);
  });

  test("counts multi-digit numbers", () => {
    expect(checkboxStates("- [x] 12. twelve\n")).toEqual(["x"]);
  });

  test("gives the same answer on repeated calls", () => {
    const plan = "- [ ] 1. a\n- [x] 2. b\n";
    expect([checkboxStates(plan), checkboxStates(plan)]).toEqual([
      [" ", "x"],
      [" ", "x"],
    ]);
  });

  test.each([
    ["mid-line", "text - [ ] 1. task"],
    ["indented", "  - [ ] 1. task"],
    ["upper-case X", "- [X] 1. task"],
    ["lettered", "- [ ] a. task"],
    ["no period", "- [ ] 1 task"],
  ])("does not count a checkbox that is %s", (_label, line) => {
    expect(checkboxStates(line)).toEqual([]);
  });
});

describe("nextTaskLabel", () => {
  test("returns the first unchecked task and skips checked ones", () => {
    const plan = "- [x] 1. Task one done\n- [ ] 2. Task two pending\n- [ ] 3. Task three pending\n";
    expect(nextTaskLabel(plan)).toBe("Task two pending");
  });

  test("is null when the plan has no numbered checkboxes", () => {
    expect(nextTaskLabel("# Plan\n\nNo tasks.\n")).toBeNull();
  });

  test("is null when every numbered checkbox is checked", () => {
    expect(nextTaskLabel("- [x] 1. Done\n- [x] 2. Done too\n")).toBeNull();
  });

  test("ignores unnumbered and upper-case checkboxes when finding the next task", () => {
    expect(nextTaskLabel("- [ ] Notify\n- [X] 1. Odd\n- [ ] 2. Real\n")).toBe("Real");
  });

  test("trims whitespace around the label", () => {
    expect(nextTaskLabel("- [ ] 1.    spaced out   \n")).toBe("spaced out");
  });

  test("strips the carriage return of a CRLF plan", () => {
    expect(nextTaskLabel("- [x] 1. a\r\n- [ ] 2. task\r\n")).toBe("task");
  });

  test("an unchecked task with no text yields an empty label, not null", () => {
    expect(nextTaskLabel("- [ ] 1.\n")).toBe("");
  });

  test("truncates a long label to 80 characters ending in an ellipsis", () => {
    expect(nextTaskLabel(`- [ ] 1. ${"x".repeat(120)}\n`)).toBe(`${"x".repeat(79)}…`);
  });

  test("keeps a label of exactly 80 characters whole", () => {
    const label = "y".repeat(MAX_LABEL_LEN);
    expect(nextTaskLabel(`- [ ] 1. ${label}\n`)).toBe(label);
  });

  test("truncates a label of 81 characters", () => {
    expect(nextTaskLabel(`- [ ] 1. ${"z".repeat(81)}\n`)).toBe(`${"z".repeat(79)}…`);
  });

  test("drops the space left at the cut before the ellipsis", () => {
    const label = `${"a".repeat(78)} ${"b".repeat(10)}`;
    expect(nextTaskLabel(`- [ ] 1. ${label}\n`)).toBe(`${"a".repeat(78)}…`);
  });

  test("counts characters outside the BMP as one each", () => {
    const label = "😀".repeat(100);
    expect(nextTaskLabel(`- [ ] 1. ${label}\n`)).toBe(`${"😀".repeat(79)}…`);
  });
});

describe("planIsComplete", () => {
  test("is true when every numbered checkbox is checked", () => {
    expect(planIsComplete("- [x] 1. Done\n- [x] 2. Also done\n")).toBe(true);
  });

  test("is false while any numbered checkbox is open", () => {
    expect(planIsComplete("- [x] 1. Done\n- [ ] 2. Open\n")).toBe(false);
  });

  test("is false for a plan with no numbered checkboxes", () => {
    expect(planIsComplete("# Empty plan\n\nNo tasks here.\n")).toBe(false);
  });

  test("is false for empty content", () => {
    expect(planIsComplete("")).toBe(false);
  });

  test("is false when only unnumbered checkboxes exist", () => {
    expect(planIsComplete("- [x] Review docs\n- [x] Notify\n")).toBe(false);
  });

  test("ignores unnumbered open checkboxes beside checked numbered ones", () => {
    expect(planIsComplete("- [x] 1. Done\n- [ ] Notify stakeholders\n")).toBe(true);
  });
});
