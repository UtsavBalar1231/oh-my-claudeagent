import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { windowOf } from "./list-window.ts";
import {
  chunks,
  clean,
  firstOpenTask,
  MARKDOWN_CHUNK,
  parsePlan,
  planTarget,
  plansDirectory,
  readable,
  recentPlans,
  tildePath,
} from "./plan-reader.ts";
import { fitMiddle } from "./ui-kit.ts";

const PLAN = [
  "# Ship the thing",
  "",
  "Intro line.",
  "",
  "## Why",
  "Because.",
  "",
  "## TODOs",
  "### Milestone 0",
  "- [x] 1. Do the first thing",
  "  - File: `a.ts`",
  "- [ ] 2. Do the second thing",
  "  ```",
  "  ## not a heading",
  "  - [ ] 9. not a task",
  "  ```",
  "",
].join("\n");

test("the parser splits headings and tasks and ignores fenced lines", () => {
  const plan = parsePlan(PLAN);
  expect(plan.title).toBe("Ship the thing");
  expect(plan.pages.map((page) => page.title)).toEqual([
    "Overview",
    "Why",
    "TODOs",
    "Milestone 0",
    "1. Do the first thing",
    "2. Do the second thing",
  ]);
  expect([plan.done, plan.total]).toEqual([1, 2]);
  expect(plan.pages[5]?.body).toContain("## not a heading");
  expect(readable(plan)).toEqual([0, 1, 4, 5]);
  expect(firstOpenTask(plan)).toBe(5);
});

test("a task page drops its own checkbox line and un-indents its details", () => {
  const plan = parsePlan(PLAN);
  expect(plan.pages[4]?.body).toBe("- File: `a.ts`");
  const bare = parsePlan("# T\n## TODOs\n- [ ] 1. Lonely task\n- [ ] 2. Next\n  - Do: it");
  expect(bare.pages.map((page) => [page.title, page.body])).toEqual([
    ["TODOs", ""],
    ["1. Lonely task", ""],
    ["2. Next", "- Do: it"],
  ]);
  expect(readable(bare)).toEqual([1, 2]);
});

test("long pages split under the Markdown cap and control characters are stripped", () => {
  const long = Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n");
  const parts = chunks(`${long}\n${"y".repeat(MARKDOWN_CHUNK * 2 + 5)}`);
  expect(parts.length).toBeGreaterThan(3);
  expect(parts.every((part) => part.length <= MARKDOWN_CHUNK)).toBe(true);
  expect(parts.join("").replaceAll("\n", "")).toBe(`${long}${"y".repeat(MARKDOWN_CHUNK * 2 + 5)}`.replaceAll("\n", ""));
  expect(clean(`a\r\nb${String.fromCharCode(27)}[31mc${String.fromCharCode(7)}​${String.fromCharCode(0xfeff)}d`)).toBe(
    "a\nb[31mcd",
  );
});

test("the list window centres on the cursor and clamps at both ends", () => {
  expect(windowOf(80, 0, 10)).toEqual({ start: 0, end: 10 });
  expect(windowOf(80, 40, 10)).toEqual({ start: 35, end: 45 });
  expect(windowOf(80, 79, 10)).toEqual({ start: 70, end: 80 });
  expect(windowOf(3, 2, 10)).toEqual({ start: 0, end: 3 });
  expect(fitMiddle("/home/u/.claude/plans/a-very-long-plan-name.md", 20, "…")).toBe("/home/u/.c…n-name.md");
  expect(fitMiddle("short", 20, "…")).toBe("short");
  expect(tildePath("/home/u/.claude/plans/x.md", "/home/u")).toBe("~/.claude/plans/x.md");
  expect(tildePath("/tmp/x.md", "/home/u")).toBe("/tmp/x.md");
});

test("the shared 46-task fixture parses into one page per heading and task, its long task in several chunks", () => {
  const plan = parsePlan(readFileSync(join(import.meta.dir, "../../tests/fixtures/plans/46-task-plan.md"), "utf8"));
  expect([plan.done, plan.total]).toEqual([12, 46]);
  expect(plan.pages.filter((page) => page.task !== undefined).map((page) => page.task?.n)).toEqual(
    Array.from({ length: 46 }, (_, i) => i + 1),
  );
  expect(plan.pages[firstOpenTask(plan)]?.title).toStartWith("13. ");
  const long = plan.pages.find((page) => page.task?.n === 31);
  expect(chunks(long?.body ?? "").length).toBeGreaterThan(1);
});

test("plansDirectory resolves inside the project root and otherwise keeps the client default", () => {
  expect(plansDirectory(undefined, "/work", "/home/u")).toBe("/home/u/.claude/plans");
  expect(plansDirectory("  ", "/work", "/home/u")).toBe("/home/u/.claude/plans");
  expect(plansDirectory(42, "/work", "/home/u")).toBe("/home/u/.claude/plans");
  expect(plansDirectory("./plans", "/work", "/home/u")).toBe("/work/plans");
  expect(plansDirectory("docs/./plans/", "/work", "/home/u")).toBe("/work/docs/plans");
  expect(plansDirectory("/work/plans", "/work", "/home/u")).toBe("/work/plans");
  expect(plansDirectory("../elsewhere", "/work", "/home/u")).toBe("/home/u/.claude/plans");
  expect(plansDirectory("/workshop/plans", "/work", "/home/u")).toBe("/home/u/.claude/plans");
});

test("a plan argument is a name in the plans directory, a home path, an absolute path or a root-relative path", () => {
  expect(planTarget("ship", "/home/u", "/work", "/work/plans")).toBe("/work/plans/ship.md");
  expect(planTarget(" ship.md ", "/home/u", "/work", "/work/plans")).toBe("/work/plans/ship.md");
  expect(planTarget("~/notes/p.md", "/home/u", "/work", "/work/plans")).toBe("/home/u/notes/p.md");
  expect(planTarget("/tmp/p.md", "/home/u", "/work", "/work/plans")).toBe("/tmp/p.md");
  expect(planTarget("docs/../plans/p.md", "/home/u", "/work", "/work/plans")).toBe("/work/plans/p.md");
});

test("recent plans are Markdown files only, newest first, capped", () => {
  const entry = (name: string, kind: string, mtimeMs: number) => ({ name, kind, mtimeMs });
  const entries = [
    entry("old.md", "file", 1),
    entry("notes.txt", "file", 9),
    entry("new.md", "file", 3),
    entry("dir.md", "dir", 0),
    entry("mid.md", "file", 2),
  ];
  expect(recentPlans(entries, "/p")).toEqual([
    { name: "new", path: "/p/new.md", mtimeMs: 3 },
    { name: "mid", path: "/p/mid.md", mtimeMs: 2 },
    { name: "old", path: "/p/old.md", mtimeMs: 1 },
  ]);
  expect(recentPlans(entries, "/p", 2).map((file) => file.name)).toEqual(["new", "mid"]);
});
