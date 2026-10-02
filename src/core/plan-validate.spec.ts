import { describe, expect, test } from "bun:test";
import { planWriteDenial } from "./plan-validate.ts";

const PLAN = "/home/user/.claude/plans/my-agent-abc123.md";
const AGENT_PLAN = "/home/user/.claude/plans/cool-cooking-sifakis-agent-deadbeef.md";
const NOTES = "/tmp/notes.md";

const denial = (path: string) =>
  `[PLAN-CHECKBOX-VERIFY] Plan file ${path} has no numbered task checkbox. Write each task as \`- [ ] 1. <task>\`; plan progress and the Stop hooks count only numbered checkboxes.`;

describe("Write judges the content", () => {
  test("a plan with a TODOs heading and numbered checkboxes is allowed", () => {
    const content = "# My Plan\n\n## TODOs\n\n- [ ] 1. Do the first thing\n- [ ] 2. Do the second thing\n";
    expect(planWriteDenial("Write", { file_path: PLAN, content })).toBeUndefined();
  });

  test("a plan with a Work Objectives heading and numbered checkboxes is allowed", () => {
    const content = "# Sprint Plan\n\n## Work Objectives\n\n- [ ] 1. Implement feature\n- [ ] 2. Write tests\n";
    expect(planWriteDenial("Write", { file_path: PLAN, content })).toBeUndefined();
  });

  test("a plan with a TODOs heading and no checkbox is denied with the reason", () => {
    const content = "# My Plan\n\n## TODOs\n\nno checkboxes here, just prose\n";
    expect(planWriteDenial("Write", { file_path: PLAN, content })).toBe(denial(PLAN));
  });

  test("a finished plan whose tasks are all checked is allowed", () => {
    const content = "# My Plan\n\n## TODOs\n\n- [x] 1. Did the first thing\n- [x] 2. Did the second thing\n";
    expect(planWriteDenial("Write", { file_path: PLAN, content })).toBeUndefined();
  });

  test("a plan with a Work Objectives heading and no checkbox is denied", () => {
    const content = "## Work Objectives\n\nSome text with no checkboxes.";
    expect(planWriteDenial("Write", { file_path: PLAN, content })).toBe(denial(PLAN));
  });

  test("a plan-style filename with no checkbox and no heading is denied", () => {
    const content = "# Agent Plan\n\nThis plan has no checkboxes at all.\n";
    expect(planWriteDenial("Write", { file_path: AGENT_PLAN, content })).toBe(denial(AGENT_PLAN));
  });

  test("a plan-style filename with a numbered checkbox is allowed", () => {
    expect(planWriteDenial("Write", { file_path: AGENT_PLAN, content: "# Agent Plan\n\n- [ ] 1. First task\n" })).toBeUndefined();
  });

  test("a checkbox without a number does not count", () => {
    const content = "## TODOs\n\n- [ ] Do the first thing\n";
    expect(planWriteDenial("Write", { file_path: PLAN, content })).toBe(denial(PLAN));
  });

  test("an indented numbered checkbox does not count", () => {
    const content = "## TODOs\n\n  - [ ] 1. Do the first thing\n";
    expect(planWriteDenial("Write", { file_path: PLAN, content })).toBe(denial(PLAN));
  });

  test("a path outside a plans directory is allowed whatever the content", () => {
    expect(planWriteDenial("Write", { file_path: NOTES, content: "# My Plan\n\n## TODOs\n\nno checkboxes\n" })).toBeUndefined();
  });

  test("a plans README without a plan heading is allowed", () => {
    const content = "# Plans directory\n\nThis directory stores plan files.\n";
    expect(planWriteDenial("Write", { file_path: "/home/user/.claude/plans/README.md", content })).toBeUndefined();
  });

  test("a task shown only inside a code fence is not a numbered task", () => {
    const fenced = "## TODOs\n\n```md\n- [ ] 1. example task\n```\n";
    expect(planWriteDenial("Write", { file_path: PLAN, content: fenced })).toBe(denial(PLAN));
    expect(planWriteDenial("Write", { file_path: PLAN, content: `${fenced}\n- [ ] 1. real task\n` })).toBeUndefined();
  });

  test("a task on the first line of a file with a byte-order mark counts", () => {
    expect(planWriteDenial("Write", { file_path: AGENT_PLAN, content: "﻿- [ ] 1. First task\n" })).toBeUndefined();
  });

  test("a heading that is not at the start of a line is not a plan heading", () => {
    expect(planWriteDenial("Write", { file_path: "/home/user/.claude/plans/README.md", content: "see ## TODOs below\n" })).toBeUndefined();
  });
});

describe("Edit judges the new_string", () => {
  test("a new_string with numbered checkboxes is allowed", () => {
    const input = { file_path: PLAN, old_string: "## TODOs\n\nno checkboxes", new_string: "## TODOs\n\n- [ ] 1. First task\n- [ ] 2. Second task\n" };
    expect(planWriteDenial("Edit", input)).toBeUndefined();
  });

  test("a new_string with a TODOs heading and no checkbox is denied", () => {
    const input = { file_path: PLAN, old_string: "## TODOs\n\n- [ ] 1. Old task", new_string: "## TODOs\n\nno checkboxes here anymore" };
    expect(planWriteDenial("Edit", input)).toBe(denial(PLAN));
  });

  test("the content field is ignored, so a checkbox there does not save the edit", () => {
    const input = { file_path: PLAN, content: "## TODOs\n\n- [ ] 1. Checkbox in wrong field\n", new_string: "## TODOs\n\nno checkboxes in new_string" };
    expect(planWriteDenial("Edit", input)).toBe(denial(PLAN));
  });

  test("an Edit of one task line, with no plan heading in the new_string, is allowed", () => {
    const input = { file_path: PLAN, old_string: "- [ ] 1. Old task", new_string: "- [ ] 1. Reworded task" };
    expect(planWriteDenial("Edit", input)).toBeUndefined();
  });

  test("a prose Edit in a plan-style file is allowed, since only a rewritten plan heading is judged", () => {
    expect(planWriteDenial("Edit", { file_path: AGENT_PLAN, old_string: "x", new_string: "prose" })).toBeUndefined();
  });

  test("a new_string that rewrites the heading with only checked tasks is allowed", () => {
    const input = { file_path: PLAN, old_string: "## TODOs", new_string: "## TODOs\n\n- [x] 1. Done task\n" };
    expect(planWriteDenial("Edit", input)).toBeUndefined();
  });

  test("a new_string whose only task is inside a code fence is denied", () => {
    const input = { file_path: PLAN, old_string: "## TODOs", new_string: "## TODOs\n\n```\n- [ ] 1. example\n```\n" };
    expect(planWriteDenial("Edit", input)).toBe(denial(PLAN));
  });

  test("a path outside a plans directory is allowed", () => {
    expect(planWriteDenial("Edit", { file_path: NOTES, old_string: "foo", new_string: "## TODOs\n\nno checkboxes" })).toBeUndefined();
  });
});

describe("other input", () => {
  test("a Read of a plan is ignored", () => {
    expect(planWriteDenial("Read", { file_path: PLAN, content: "## TODOs\n\nno checkboxes" })).toBeUndefined();
  });

  test("an input that is not an object is allowed", () => {
    expect(planWriteDenial("Write", undefined)).toBeUndefined();
    expect(planWriteDenial("Write", "## TODOs")).toBeUndefined();
  });
});

describe("Windows and macOS paths", () => {
  const prose = "# My Plan\n\n## TODOs\n\nno checkboxes here, just prose\n";

  test.each([
    "C:\\Users\\x\\.claude\\plans\\my-plan.md",
    "C:/Users/x/.claude/plans/my-plan.md",
    "/c/Users/x/.claude/plans/my-plan.md",
    "\\\\srv\\share\\.claude\\plans\\my-plan.md",
    "/Users/Me/.claude/plans/my-plan.md",
  ])("a plan at %p with no checkbox is denied", (file_path) => {
    expect(planWriteDenial("Write", { file_path, content: prose })).toBe(denial(file_path));
  });

  test.each(["C:\\Users\\x\\.claude\\plans\\cool-agent-deadbeef.md", "\\\\srv\\share\\plans\\cool-agent-deadbeef.md"])(
    "the agent plan name at %p is read from its last segment",
    (file_path) => {
      expect(planWriteDenial("Write", { file_path, content: "# Agent Plan\n\nno boxes\n" })).toBe(denial(file_path));
      expect(planWriteDenial("Write", { file_path, content: "# Agent Plan\n\n- [ ] 1. First\n" })).toBeUndefined();
    },
  );

  test("a prose file outside any plans directory is left alone", () => {
    expect(planWriteDenial("Write", { file_path: "C:\\Users\\x\\notes\\p-agent-1.md", content: prose })).toBeUndefined();
  });
});
