import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkboxStates } from "./checkboxes.ts";
import { windowOf } from "./list-window.ts";
import type { Env } from "./path.ts";
import {
  boardOf,
  checksOf,
  chunks,
  clean,
  fieldsOf,
  firstOpenTask,
  MARKDOWN_CHUNK,
  parsePlan,
  pathsOf,
  planTarget,
  plansDirectory,
  readable,
  recentPlans,
  taskMarkdown,
  taskReference,
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

test("an upper-case X is no task, so the parser and the checkbox module count the same", () => {
  const text = "# P\n\n## TODOs\n- [x] 1. a\n- [X] 2. b\n- [ ] 3. c\n";
  const plan = parsePlan(text);
  const states = checkboxStates(text);
  expect([plan.done, plan.total]).toEqual([1, 2]);
  expect([states.filter((state) => state === "x").length, states.length]).toEqual([1, 2]);
  expect(plan.pages.flatMap((page) => (page.task === undefined ? [] : [page.task.n]))).toEqual([1, 3]);
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

const POSIX_ENV = { HOME: "/home/u" };
const DEFAULT_PLANS = "/home/u/.claude/plans";

test("plansDirectory resolves inside the project root and otherwise keeps the client default", () => {
  const plans = (setting: unknown, root = "/work", env: Env = POSIX_ENV) => plansDirectory("linux", setting, root, env);
  expect(plans(undefined)).toBe(DEFAULT_PLANS);
  expect(plans("  ")).toBe(DEFAULT_PLANS);
  expect(plans(42)).toBe(DEFAULT_PLANS);
  expect(plans("./plans")).toBe("/work/plans");
  expect(plans("docs/./plans/")).toBe("/work/docs/plans");
  expect(plans("/work/plans")).toBe("/work/plans");
  expect(plans("../elsewhere")).toBe(DEFAULT_PLANS);
  expect(plans("/workshop/plans")).toBe(DEFAULT_PLANS);
  expect(plans("~/plans")).toBe(DEFAULT_PLANS);
  expect(plans("~/plans", "/home/u")).toBe("/home/u/plans");
});

test("the default plans directory follows CLAUDE_CONFIG_DIR, and is undefined when no home resolves", () => {
  expect(plansDirectory("linux", undefined, "/work", { HOME: "/home/u", CLAUDE_CONFIG_DIR: "/cfg" })).toBe("/cfg/plans");
  expect(plansDirectory("linux", undefined, "/work", { CLAUDE_CONFIG_DIR: "/cfg" })).toBe("/cfg/plans");
  expect(plansDirectory("linux", undefined, "/work", {})).toBeUndefined();
  expect(plansDirectory("linux", undefined, "/work", { HOME: "" })).toBeUndefined();
  expect(plansDirectory("linux", "  ", "/work", {})).toBeUndefined();
  expect(plansDirectory("linux", "../elsewhere", "/work", {})).toBeUndefined();
  expect(plansDirectory("linux", "./plans", "/work", {})).toBe("/work/plans");
  expect(plansDirectory("linux", "~/plans", "/work", {})).toBeUndefined();
});

test("plansDirectory reads drive, UNC, Git Bash and mixed-case roots", () => {
  const user = { USERPROFILE: "C:\\Users\\x" };
  expect(plansDirectory("win32", ".plans", "C:\\proj", user)).toBe("C:/proj/.plans");
  expect(plansDirectory("win32", "docs\\plans", "C:\\proj", user)).toBe("C:/proj/docs/plans");
  expect(plansDirectory("win32", "C:\\proj\\plans", "C:\\proj", user)).toBe("C:/proj/plans");
  expect(plansDirectory("win32", "c:/PROJ/plans", "C:\\proj", user)).toBe("c:/PROJ/plans");
  expect(plansDirectory("win32", "D:\\plans", "C:\\proj", user)).toBe("C:/Users/x/.claude/plans");
  expect(plansDirectory("win32", "..\\plans", "C:\\proj", user)).toBe("C:/Users/x/.claude/plans");
  expect(plansDirectory("win32", undefined, "C:\\proj", user)).toBe("C:/Users/x/.claude/plans");
  expect(plansDirectory("win32", undefined, "C:\\proj", { HOMEDRIVE: "C:", HOMEPATH: "\\Users\\x" })).toBe("C:/Users/x/.claude/plans");
  expect(plansDirectory("win32", "~\\plans", "C:\\Users\\x", user)).toBe("C:/Users/x/plans");
  expect(plansDirectory("win32", "plans", "/c/proj", user)).toBe("c:/proj/plans");
  expect(plansDirectory("win32", "share\\plans", "\\\\srv\\share\\proj", user)).toBe("//srv/share/proj/share/plans");
  expect(plansDirectory("win32", "\\\\srv\\share\\proj\\plans", "\\\\srv\\share\\proj", user)).toBe("//srv/share/proj/plans");
  expect(plansDirectory("darwin", "plans", "/Users/Me/proj", { HOME: "/Users/Me" })).toBe("/Users/Me/proj/plans");
  expect(plansDirectory("darwin", "/users/me/PROJ/plans", "/Users/Me/proj", { HOME: "/Users/Me" })).toBe("/users/me/PROJ/plans");
});

test("a plan argument is a name in the plans directory, a home path, an absolute path or a root-relative path", () => {
  const target = (argument: string) => planTarget("linux", argument, "/home/u", "/work", "/work/plans");
  expect(target("ship")).toBe("/work/plans/ship.md");
  expect(target(" ship.md ")).toBe("/work/plans/ship.md");
  expect(target("~/notes/p.md")).toBe("/home/u/notes/p.md");
  expect(target("/tmp/p.md")).toBe("/tmp/p.md");
  expect(target("docs/../plans/p.md")).toBe("/work/plans/p.md");
  expect(target("~ship")).toBe("/work/plans/~ship.md");
  expect(planTarget("linux", "~/p.md", "", "/work", "/work/plans")).toBe("~/p.md");
});

test("a plan argument on Windows accepts drive, UNC, Git Bash and backslash forms", () => {
  const target = (argument: string) => planTarget("win32", argument, "C:\\Users\\x", "C:\\proj", "C:/Users/x/.claude/plans");
  expect(target("ship")).toBe("C:/Users/x/.claude/plans/ship.md");
  expect(target("~\\notes\\p.md")).toBe("C:/Users/x/notes/p.md");
  expect(target("~/notes/p.md")).toBe("C:/Users/x/notes/p.md");
  expect(target("D:\\plans\\p.md")).toBe("D:\\plans\\p.md");
  expect(target("C:/plans/p.md")).toBe("C:/plans/p.md");
  expect(target("/c/plans/p.md")).toBe("/c/plans/p.md");
  expect(target("\\\\srv\\share\\p.md")).toBe("\\\\srv\\share\\p.md");
  expect(target("docs\\..\\plans\\p.md")).toBe("C:/proj/plans/p.md");
  expect(planTarget("win32", "~\\p.md", "", "C:\\proj", "C:/plans")).toBe("~\\p.md");
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

const BOARD = [
  "# Ship it",
  "",
  "**Scope**: 4 files | **Parallel Execution**: NO | **Status**: FINAL",
  "",
  "## TODOs",
  "- [x] 1. Set up",
  "### Milestone 1: Core",
  "",
  "- [x] 2. [P] Build the core",
  "  - File: `src/core.ts` (new), `src/core.spec.ts`, `justfile` (`bench` recipe), `docs/` (dir)",
  "  - Do: write the core.",
  "    Keep it small.",
  "  - Done when: `bun test src/core.spec.ts` exits 0 and `CORE_FLAG` is unset.",
  "  - Depends: 1",
  "- [ ] 3. Wire the band",
  "  - File: src/band.ts, src/*.ts, README",
  "  - Done when: `just ci` and `just validate --check claims` exit 0.",
  "  - Depends: 2, 2, 3, 99; and the review",
  "  - Must NOT: touch the server.",
  "### Milestone 2: Empty heading",
  "## Deferred backlog",
  "### UI",
  "- **The Hill** (L). Not a task.",
  "- [ ] not numbered",
  "",
].join("\n");

test("the board groups tasks by the heading above them and reads each task's fields", () => {
  const plan = parsePlan(BOARD);
  const board = boardOf(plan);
  expect(board.status).toBe("FINAL");
  expect(board.groups).toEqual([
    { title: "TODOs", tasks: [1] },
    { title: "Milestone 1: Core", tasks: [2, 3] },
  ]);
  expect(board.cards.map(({ n, done, title, group, page, files, depends, checks }) => ({ n, done, title, group, page, files, depends, checks }))).toEqual([
    { n: 1, done: true, title: "Set up", group: 0, page: 2, files: [], depends: [], checks: [] },
    {
      n: 2,
      done: true,
      title: "[P] Build the core",
      group: 1,
      page: 4,
      files: ["src/core.ts", "src/core.spec.ts", "justfile"],
      depends: [1],
      checks: ["bun test src/core.spec.ts"],
    },
    {
      n: 3,
      done: false,
      title: "Wire the band",
      group: 1,
      page: 5,
      files: ["src/band.ts"],
      depends: [2],
      checks: ["just ci", "just validate --check claims"],
    },
  ]);
  expect(board.cards[2]?.fields).toEqual([
    { name: "File", text: "src/band.ts, src/*.ts, README" },
    { name: "Done when", text: "`just ci` and `just validate --check claims` exit 0." },
    { name: "Depends", text: "2, 2, 3, 99; and the review" },
    { name: "Must NOT", text: "touch the server." },
  ]);
});

test("a plan's plain bullets are never tasks, and its Status is read only before the first task", () => {
  const board = boardOf(parsePlan(BOARD));
  expect(board.cards.map((card) => card.n)).toEqual([1, 2, 3]);
  expect(boardOf(parsePlan("# P\n\n## TODOs\n- [ ] 1. A\n\n**Status**: DRAFT\n")).status).toBeNull();
  expect(boardOf(parsePlan("# P\n\nStatus: draft\n\n- [ ] 1. A\n")).status).toBe("DRAFT");
  expect(boardOf(parsePlan("# P\n\n## Why\nNo tasks.\n"))).toEqual({ status: null, groups: [], cards: [] });
});

test("fields continue on deeper lines and text before the first field is kept unnamed", () => {
  expect(fieldsOf("A note.\n- Do: one\n  two\n\n- Done when: `x y`")).toEqual([
    { name: "", text: "A note." },
    { name: "Do", text: "one\ntwo" },
    { name: "Done when", text: "`x y`" },
  ]);
});

test("pathsOf takes one path per listed item and leaves globs, directories and annotations out", () => {
  expect(pathsOf("`a.ts` (new, generated), `b/c.ts`, `d/` (scratch), `e/**/*.ts`, `a.ts`")).toEqual(["a.ts", "b/c.ts"]);
  expect(pathsOf("spike record `spike.md` in the ADR directory")).toEqual(["spike.md"]);
  expect(pathsOf("src/a.ts (new), notes, /abs/b.md")).toEqual(["src/a.ts", "/abs/b.md"]);
  expect(pathsOf("")).toEqual([]);
});

test("checksOf keeps the code spans that carry an argument", () => {
  expect(checksOf("`just ci` exits 0, `FLAG` unset, `bun test a.spec.ts` passes")).toEqual(["just ci", "bun test a.spec.ts"]);
});

test("taskReference reads the task a delegation names on its first line, then in its description", () => {
  expect(taskReference("Task 43: port the parser\nDepends on task 12")).toBe(43);
  expect(taskReference("  task #7 now")).toBe(7);
  expect(taskReference("1. TASK: Build the board\n2. Task 9", "Task 12 board")).toBe(12);
  expect(taskReference("Fix the parser", "Fix it")).toBeUndefined();
});

test("taskMarkdown writes the task back as the plan spells it", () => {
  const card = boardOf(parsePlan(BOARD)).cards[2];
  expect(card === undefined ? "" : taskMarkdown(card, "- File: a.ts\n\n- Do: b")).toBe("- [ ] 3. Wire the band\n  - File: a.ts\n\n  - Do: b");
});
