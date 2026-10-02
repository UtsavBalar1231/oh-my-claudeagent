import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { handle } from "./plan-format-warn.ts";

const NOW = 1_786_000_000_000;
const FIX = "Fix: a - [ ] line not matching '- [ ] N.' will not be counted; use the numbered form.";
const roots: string[] = [];

afterEach(() => {
  delete process.env.OMCA_DISABLED_HOOKS;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function file(relative: string, content: string): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "omca-plan-format-"));
  roots.push(root);
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return { root, path };
}

const warn = async (root: string, path: string, tool = "Write") =>
  (await handle({ event: "PostToolUse", tool_name: tool, tool_input: { file_path: path } }, { root, now: NOW, session: undefined }))
    ?.hookSpecificOutput?.additionalContext;

test("plan-format-warn: malformed checkbox line triggers a warning naming it", async () => {
  const { root, path } = file("plans/test-plan.md", "# My Plan\n\n- [ ] 1. First task\n- [ ] Task 2: malformed, no number-dot\n");
  expect(await warn(root, path)).toBe(
    [`[PLAN-FORMAT-WARN] ${path} has 1 checkbox line(s) that will not be counted as numbered tasks:`, "4:- [ ] Task 2: malformed, no number-dot", FIX].join("\n"),
  );
});

test("plan-format-warn: an Edit that leaves a malformed line warns the same way", async () => {
  const { root, path } = file("plans/test-plan.md", "- [ ] Task 1: malformed\n- [x] 2. Done\n");
  expect(await warn(root, path, "Edit")).toBe(
    [`[PLAN-FORMAT-WARN] ${path} has 1 checkbox line(s) that will not be counted as numbered tasks:`, "1:- [ ] Task 1: malformed", FIX].join("\n"),
  );
});

test("plan-format-warn: a plan under a mixed-case home directory is judged like any other", async () => {
  const { root, path } = file("Users/Me/.claude/plans/test-plan.md", "- [ ] Task 1: malformed\n- [x] 2. Done\n");
  expect(await warn(root, path)).toBe(
    [`[PLAN-FORMAT-WARN] ${path} has 1 checkbox line(s) that will not be counted as numbered tasks:`, "1:- [ ] Task 1: malformed", FIX].join("\n"),
  );
});

test("plan-format-warn: more than five malformed lines are named up to five with a count of the rest", async () => {
  const boxes = Array.from({ length: 7 }, (_, i) => `- [ ] step ${i + 1}`);
  const { root, path } = file("plans/long.md", `- [ ] 1. Numbered\n${boxes.join("\n")}\n`);
  expect(await warn(root, path)).toBe(
    [
      `[PLAN-FORMAT-WARN] ${path} has 7 checkbox line(s) that will not be counted as numbered tasks:`,
      ...boxes.slice(0, 5).map((line, i) => `${i + 2}:${line}`),
      "...and 2 more",
      FIX,
    ].join("\n"),
  );
});

test("plan-format-warn: well-formed plan emits no output", async () => {
  const { root, path } = file("plans/good-plan.md", "# My Plan\n\n- [ ] 1. First task\n- [x] 2. Second task\n");
  expect(await warn(root, path)).toBeUndefined();
});

test("plan-format-warn: a checked box, a nested box and prose about '- [ ]' are not malformed task lines", async () => {
  const { root, path } = file("plans/mentions.md", "- [x] done without a number\n  - [ ] nested sub-step\nWrite each task as `- [ ] N.` here.\n- [ ] 1. Real task\n");
  expect(await warn(root, path)).toBeUndefined();
});

test("plan-format-warn: non-plan file path emits no output", async () => {
  const { root, path } = file("src/notes.md", "- [ ] Task 2: malformed, no number-dot\n");
  expect(await warn(root, path)).toBeUndefined();
});

test("plan-format-warn: a file nested below a plans directory is not a plan", async () => {
  const { root, path } = file("plans/archive/old.md", "- [ ] Task 2: malformed, no number-dot\n");
  expect(await warn(root, path)).toBeUndefined();
});

test("plan-format-warn: a Read of a malformed plan emits no output", async () => {
  const { root, path } = file("plans/test-plan.md", "- [ ] Task 2: malformed, no number-dot\n");
  expect(await warn(root, path, "Read")).toBeUndefined();
});

test("plan-format-warn: a plan path that does not exist emits no output", async () => {
  const { root } = file("plans/other.md", "");
  expect(await warn(root, join(root, "plans", "missing.md"))).toBeUndefined();
});

test("plan-format-warn: OMCA_DISABLED_HOOKS kill switch suppresses output", async () => {
  const { root, path } = file("plans/test-plan.md", "- [ ] 1. First task\n- [ ] Task 2: malformed, no number-dot\n");
  process.env.OMCA_DISABLED_HOOKS = "plan-format-warn";
  expect(await warn(root, path)).toBeUndefined();
  process.env.OMCA_DISABLED_HOOKS = "context-injector";
  expect(await warn(root, path)).toStartWith("[PLAN-FORMAT-WARN] ");
});
