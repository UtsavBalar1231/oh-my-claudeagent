import { type Engine, expect, type Plugin, test } from "claude-code/testing";
import { displayWidth, usableColumns } from "../../src/core/ui-kit.ts";
import { joinPath } from "../../src/core/path.ts";
import { TASK_TOOLS_OFF } from "../../src/core/native-tasks.ts";
import { bodyColumns, focusRequests, isAscii, LAYOUTS, LEDGER, local, pane, POSIX, rows, run, SESSION, type Size, SIZES, spreadRows, usage, world, write } from "./world.ts";

const DOCK: Size = { columns: 160, rows: 45, placement: "dock" };
const SHORT: Size = { columns: 160, rows: 16, placement: "dock" };
const HOME = POSIX.home;
const LIST = `${HOME}/.claude/tasks/${SESSION}`;
const OMCA_BAR = "1: Agents  2: Evidence  3: Notepad";

type Fields = { id: string; subject: string; status?: string; description?: string; owner?: string; blocks?: string[]; blockedBy?: string[]; metadata?: Record<string, unknown> };

const stored = ({ status = "pending", description = "", blocks = [], blockedBy = [], ...rest }: Fields) => JSON.stringify({ status, description, activeForm: "", blocks, blockedBy, ...rest });
const fileOf = (task: Fields, dir = LIST) => [`${dir}/${task.id}.json`, stored(task)] as const;
const filesOf = (...tasks: readonly Fields[]) => Object.fromEntries(tasks.map((task) => fileOf(task)));

const WORK: readonly Fields[] = [
  { id: "1", subject: "Map the auth flow", status: "completed", description: "Read the middleware." },
  { id: "2", subject: "Port the parser", status: "in_progress", owner: "executor", description: "Move it to the helper.\n\n- Keep the errors", blocks: ["3"], metadata: { files: ["src/parser.ts"], risk: "low" } },
  { id: "3", subject: "Add the migration", description: "Forward only.", blockedBy: ["2"] },
  { id: "4", subject: "Update the docs", description: "Cover the helper." },
];

const tasklist = () => ({ ...run(""), command: "tasklist" });

async function open($: Engine, size: Size = DOCK) {
  await $.command.run(tasklist());
  return $.ui.mount({ ...pane("terminal", size), requestId: "tasklist" });
}

// Rows as they read: runs of spaces as two, a rule or the bar as one cell of each kind.
const norm = (line: string) => line.trimEnd().replace(/ {2,}/g, "  ").replace(/─+/g, "─").replace(/━+/g, "━");
const shown = async (ui: { drawn: () => Promise<Parameters<typeof rows>[0]> }) => rows(await ui.drawn()).map(norm);
const RULE = /^(Running|Ready|Blocked|Waiting|Done)\b.*─$/;

// Another plugin's close reaches the pane's close feature with origin `plugin`; a test cannot raise the person's Esc.
const CLOSER: Plugin = {
  name: "closer",
  register(on) {
    on("command.run", { command: "close-tasklist" }, async ($) => {
      await $.ui.close({ id: "tasklist" });
      return { text: "" };
    });
  },
};

const closeRun = { ...run(""), command: "close-tasklist" };

test("/tasklist opens its own pane, Tasks, focused and closable by Esc", async ($, on) => {
  const w = world(on, filesOf(...WORK));
  expect(await $.command.run(tasklist())).toEqual({});
  expect(w.opened).toEqual([{ id: "tasklist", title: "Tasks", focus: true, closeOnEscape: true, rows: 12, columns: 56 }]);
});

test("/tasklist says why when no surface is attached or the pane is not placed", async ($, on) => {
  const w = world(on);
  w.unplaced = "no-surface";
  expect(await $.command.run(tasklist())).toEqual({ text: "No surface is attached to this session, as under claude -p, so the task list is not drawn. Run /tasklist in a terminal or the Desktop app." });
  w.unplaced = "needs 144 columns, has 100";
  expect(await $.command.run(tasklist())).toEqual({ text: "The task list is open but not drawn yet: needs 144 columns, has 100" });
});

test("the OMCA pane's tab bar names three tabs, and the task list has no tab there", async ($, on) => {
  world(on, filesOf(...WORK));
  await $.command.run(run(""));
  const ui = await $.ui.mount(pane("terminal", DOCK));
  expect(rows(await ui.drawn())[0]).toBe(OMCA_BAR);
  expect(await ui.find({ key: "task-2" })).toBeUndefined();
  await ui.unmount();
});

test("closing the task list leaves the OMCA pane's tab and rows alone", { plugins: [CLOSER] }, async ($, on) => {
  const w = world(on, filesOf(...WORK));
  await $.command.run(run(""));
  const omca = await $.ui.mount(pane("terminal", DOCK));
  await omca.press({ key: "2" });
  const before = rows(await omca.drawn());
  const tasks = await open($);
  expect(await tasks.find({ key: "task-2" })).toBeDefined();
  expect(rows(await tasks.drawn()).join("\n")).not.toContain(OMCA_BAR);

  await tasks.unmount();
  await $.command.run(closeRun);
  await w.clock.advance(4000);
  await omca.redraw();
  expect(rows(await omca.drawn())).toEqual(before);
  expect((await omca.find({ key: "2" }))?.props["dimColor"]).toBeUndefined();
  await omca.unmount();
});

test("closing the task list stops its reads and forgets its place, and leaves the OMCA pane's timer running", { plugins: [CLOSER] }, async ($, on) => {
  const w = world(on, filesOf(...WORK));
  await $.command.run(run(""));
  const ui = await open($);
  await ui.press({ key: "task-2" });
  expect(rows(await ui.drawn()).join("\n")).toContain("Move it to the helper.");
  await ui.unmount();

  await $.command.run(closeRun);
  w.reads.length = 0;
  await w.clock.advance(4000);
  expect(w.reads.filter((path) => path.startsWith(LIST))).toEqual([]);
  expect(w.reads.some((path) => path.includes(".omca"))).toBe(true);

  const again = await open($);
  expect(await again.find({ key: "task-2" })).toBeDefined();
  expect(rows(await again.drawn()).join("\n")).toContain("1 of 4 done");
  await again.unmount();
});

test("the open pane reads the list every two seconds", { plugins: [CLOSER] }, async ($, on) => {
  const w = world(on, filesOf(...WORK));
  const ui = await open($);
  write(w, `${LIST}/4.json`, stored({ id: "4", subject: "Update the docs", status: "completed" }));
  await w.clock.advance(2000);
  await ui.redraw();
  expect(rows(await ui.drawn()).join("\n")).toContain("2 of 4 done");
  await ui.unmount();
  await $.command.run(closeRun);
});

test("the list runs in the order the work runs, each section under its rule, a blank row between them when the pane has the rows", async ($, on) => {
  world(on, filesOf(...WORK));
  const ui = await open($);
  const lines = await shown(ui);
  expect(lines.slice(0, 14)).toEqual([
    "1 of 4 done",
    "━─",
    "◐ 1 running  ○ 1 ready  · 1 waiting",
    "",
    "Running ─",
    "◐ #2  Port the parser  executor",
    "",
    "Ready ─",
    "○ #4  Update the docs",
    "",
    "Waiting ─",
    "· #3  Add the migration  ← #2",
    "",
    "Done ✓ 1 ─ d: show ─",
  ]);
  expect(lines.at(-1)).toBe("↑↓ move  ⏎ open  d: done  esc close");
  expect(lines.at(-2)).toBe("");
  await ui.unmount();
});

test("a pane short of rows drops the blank rows first, then the counts row", async ($, on) => {
  world(on, filesOf(...WORK));
  const compact = await open($, { columns: 160, rows: 15, placement: "dock" });
  const lines = await shown(compact);
  expect(lines.slice(0, 10)).toEqual(["1 of 4 done", "━─", "◐ 1 running  ○ 1 ready  · 1 waiting", "Running ─", "◐ #2  Port the parser  executor", "Ready ─", "○ #4  Update the docs", "Waiting ─", "· #3  Add the migration  ← #2", "Done ✓ 1 ─ d: show ─"]);
  await compact.unmount();
  const shorter = await open($, { columns: 160, rows: 14, placement: "dock" });
  expect((await shown(shorter)).slice(0, 3)).toEqual(["1 of 4 done", "━─", "Running ─"]);
  await shorter.unmount();
});

const RUN = { run: "auth-rewrite" };

test("the head row names the run on the left and its count on the right", async ($, on) => {
  world(on, filesOf({ id: "1", subject: "Port", metadata: RUN }, { id: "2", subject: "Docs", status: "completed", metadata: RUN }));
  const ui = await open($);
  const head = rows(await ui.drawn())[0]?.trimEnd() ?? "";
  expect(head).toStartWith("auth-rewrite ");
  expect(head).toEndWith(" 1 of 2 done");
  expect(displayWidth(head)).toBe(usableColumns(bodyColumns(DOCK)));
  await ui.unmount();
});

test("a list with no run names none", async ($, on) => {
  world(on, filesOf({ id: "1", subject: "Port" }));
  const plain = await open($);
  expect(rows(await plain.drawn())[0]?.trimEnd()).toBe("0 of 1 done");
  await plain.unmount();
});

test("a long run name wraps to two rows and keeps its count whole at the narrowest size", async ($, on) => {
  world(on, filesOf({ id: "1", subject: "Port", metadata: { run: "r".repeat(300) } }));
  const size: Size = { columns: 80, rows: 40, placement: "inline" };
  const ui = await open($, size);
  const head = rows(await ui.drawn()).slice(0, 3).map((line) => line.trimEnd());
  expect(head[0]).toMatch(/^r+$/);
  expect(head[1]).toMatch(/^r+…$/);
  expect(head[2]).toEndWith("0 of 1 done");
  for (const line of head) expect(displayWidth(line)).toBeLessThanOrEqual(usableColumns(bodyColumns(size)));
  await ui.unmount();
});

test("a task closed as blocked sits under Blocked whatever its status, with why on its own row, and its page says it whole", async ($, on) => {
  const why = `the vendor API is down until ${"next ".repeat(30)}week`;
  world(on, filesOf({ id: "1", subject: "Call the vendor", status: "in_progress", owner: "executor", metadata: { blocked: why } }, { id: "2", subject: "Ship" }));
  const ui = await open($);
  const lines = await shown(ui);
  expect(lines[0]).toBe("0 of 2 done");
  expect(lines[2]).toBe("○ 1 ready  ⊗ 1 blocked");
  const at = lines.indexOf("Blocked ─");
  expect(lines[at + 1]).toBe("⊗ #1  Call the vendor");
  expect(lines[at + 2]).toMatch(/^ {2}the vendor API is down until next .*…$/);
  expect(lines.join("\n")).not.toContain("running");
  await ui.press({ key: "task-1" });
  const page = spreadRows(await ui.drawn()).map((line) => line.trimEnd());
  expect(page).toContain("⊗ Blocked · executor");
  expect(page.join(" ").replace(/ +/g, " ")).toContain(why.replace(/ +/g, " "));
  await ui.unmount();
});

test("the final task sits last in its section with the final mark, and counts the tasks it still waits on", async ($, on) => {
  world(
    on,
    filesOf(
      { id: "1", subject: "Port", status: "in_progress", owner: "executor" },
      { id: "2", subject: "Verify", blockedBy: ["1", "3", "4"], metadata: { final: true } },
      { id: "3", subject: "Docs", blockedBy: ["1"] },
      { id: "4", subject: "Tag" },
    ),
  );
  const ui = await open($);
  const lines = await shown(ui);
  const at = lines.indexOf("Waiting ─");
  expect(lines.slice(at + 1, at + 3)).toEqual(["· #3  Docs  ← #1", "◆ #2  Verify  ← 3 open"]);
  await ui.unmount();
});

test("a waiting task names its first open blocker and how many more", async ($, on) => {
  world(on, filesOf({ id: "1", subject: "Port", status: "in_progress" }, { id: "2", subject: "Lint" }, { id: "3", subject: "Docs", blockedBy: ["1", "2"] }));
  const ui = await open($);
  expect(await shown(ui)).toContain("· #3  Docs  ← #1 +1");
  await ui.unmount();
});

test("a secret in a blocked reason or a run name is masked", async ($, on) => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  world(on, filesOf({ id: "1", subject: "Call", metadata: { run: `r-${secret}`, blocked: `token ${secret} refused` } }));
  const ui = await open($);
  expect(rows(await ui.drawn()).join("\n")).not.toContain(secret);
  await ui.press({ key: "task-1" });
  expect(spreadRows(await ui.drawn()).join("\n")).not.toContain(secret);
  await ui.unmount();
});

test("the bar is heavy for what is done and running and light for the rest, a waiting task painted like a todo one", async ($, on) => {
  world(on, filesOf({ id: "1", subject: "Map", status: "completed" }, { id: "2", subject: "Port", status: "in_progress" }, { id: "3", subject: "Docs", blockedBy: ["2"] }, { id: "4", subject: "Tag", blockedBy: ["2"] }));
  const ui = await open($);
  const segments = (await ui.findAll({ type: "Text" })).filter((found) => /^(━+|─+)$/.test(String(found.children?.[0])));
  const bar = segments.slice(0, 3).map((found) => [String(found.children?.[0]).charAt(0), found.props["color"]]);
  expect(bar).toEqual([
    ["━", "success"],
    ["━", "claude"],
    ["─", "inactive"],
  ]);
  await ui.unmount();
});

test("Enter opens a task's page: its state, what it holds up before its description, and its metadata; b goes back to that row", async ($, on) => {
  const w = world(on, filesOf(...WORK));
  const ui = await open($);
  await ui.press({ key: "task-2" });
  const lines = spreadRows(await ui.drawn()).map(norm);
  expect(lines[0]).toBe("#2 Port the parser");
  expect(lines[1]).toBe("◐ Running · executor");
  expect(lines).toContain("Move it to the helper.");
  expect(lines).toContain("- Keep the errors");
  expect(lines.indexOf("Holds up ─")).toBeGreaterThan(1);
  expect(lines[lines.indexOf("Holds up ─") + 1]).toBe("· #3  Add the migration");
  expect(lines.indexOf("Holds up ─")).toBeLessThan(lines.indexOf("Description ─"));
  expect(lines).toContain('files  ["src/parser.ts"]');
  expect(lines).toContain("risk  low");
  await ui.press({ key: "b" });
  expect(await ui.find({ key: "task-2" })).toBeDefined();
  await w.clock.settle();
  expect(focusRequests(w.logs).at(-1)).toBe("task-2");
  await ui.unmount();
});

test("the record of a finished list stays after Claude Code deletes its files", async ($, on) => {
  const w = world(on, filesOf(...WORK));
  on("tool.call", () => ({ result: {} }) as never);
  const ui = await open($);
  const done = WORK.map((task) => ({ ...task, status: "completed" }));
  for (const task of done) write(w, `${LIST}/${task.id}.json`, stored(task));
  await $.tool.call({ tool: "TaskUpdate", taskId: "4", status: "completed" });
  expect(rows(await ui.drawn()).join("\n")).toContain("4 of 4 done");
  for (const task of done) w.files.delete(`${LIST}/${task.id}.json`);
  await $.tool.call({ tool: "TaskUpdate", taskId: "9" });
  const lines = rows(await ui.drawn()).map((line) => line.trimEnd());
  expect(lines).toContain("Finished. Claude Code cleared its list; the record stays here.");
  expect(lines).toContain("✓ #4  Update the docs");
  expect(lines.join("\n")).toContain("4 of 4 done");
  await ui.unmount();
});

test("a task deleted on purpose leaves the record, and a new list joins the finished one", async ($, on) => {
  const w = world(on, filesOf({ id: "1", subject: "First", status: "completed" }, { id: "2", subject: "Second", status: "completed" }));
  on("tool.call", () => ({ result: {} }) as never);
  const ui = await open($);
  w.files.delete(`${LIST}/1.json`);
  w.files.delete(`${LIST}/2.json`);
  write(w, `${LIST}/3.json`, stored({ id: "3", subject: "Third" }));
  await $.tool.call({ tool: "TaskUpdate", taskId: "1", status: "deleted" });
  const lines = (await shown(ui)).join("\n");
  expect(lines).toContain("1 of 2 done");
  expect(lines).toContain("Done ✓ 1");
  expect(lines).toContain("#3  Third");
  expect(lines).not.toContain("First");
  expect(lines).not.toContain("cleared its list");
  await ui.unmount();
});

test("a task Claude Code keeps to itself and a file that is not a task stay out of the list", async ($, on) => {
  world(on, { ...filesOf({ id: "1", subject: "Hidden", metadata: { _internal: true } }, { id: "2", subject: "Shown" }), [`${LIST}/3.json`]: "not json", [`${LIST}/.lock`]: "" });
  const ui = await open($);
  const lines = rows(await ui.drawn()).join("\n");
  expect(lines).toContain("0 of 1 done");
  expect(lines).toContain("#2  Shown");
  expect(lines).not.toContain("Hidden");
  await ui.unmount();
});

test("CLAUDE_CODE_TASK_LIST_ID names the list, cut to the characters Claude Code allows", async ($, on) => {
  world(on, Object.fromEntries([fileOf({ id: "1", subject: "Shared" }, `${HOME}/.claude/tasks/my-plan-1`)]), {}, { CLAUDE_CODE_TASK_LIST_ID: "my plan/1" });
  const ui = await open($);
  expect(rows(await ui.drawn()).join("\n")).toContain("#1  Shared");
  await ui.unmount();
});

for (const layout of LAYOUTS) {
  test(`the session's list is read under the config directory on ${layout.name}`, async ($, on) => {
    world(on, { [joinPath(layout.platform, layout.home, ".claude", "tasks", SESSION, "1.json")]: stored({ id: "1", subject: "Found it" }) }, {}, {}, layout);
    const ui = await open($);
    expect(rows(await ui.drawn()).join("\n")).toContain("#1  Found it");
    await ui.unmount();
  });
}

test("without a home or config directory the pane names what is missing rather than reading forever", async ($, on) => {
  const w = world(on, {}, {}, {}, { ...POSIX, env: {} });
  const ui = await open($);
  const shown = spreadRows(await ui.drawn()).join(" ");
  expect(shown).toContain("None of HOME, USERPROFILE or CLAUDE_CONFIG_DIR is set");
  expect(shown).not.toContain("Reading the task list");
  expect(w.lists).toEqual([]);
  await ui.unmount();
});

test("a turn's end reads the list, so tasks finished and deleted while the pane was closed are still listed", async ($, on) => {
  const w = world(on, filesOf(...WORK));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  const done = WORK.map((task) => ({ ...task, status: "completed" }));
  for (const task of done) write(w, `${LIST}/${task.id}.json`, stored(task));
  await $.turn.complete({ answer: "Done.", durationMs: 1000, isAborted: false, turnId: "t-1", reason: "answer", usage: usage(10, 5) });
  for (const task of done) w.files.delete(`${LIST}/${task.id}.json`);
  const ui = await open($);
  const lines = rows(await ui.drawn()).join("\n");
  expect(lines).toContain("4 of 4 done");
  expect(lines).toContain("#4  Update the docs");
  expect(lines).not.toContain("No tasks yet.");
  await ui.unmount();
});

test("an empty list says so and reads no files", async ($, on) => {
  const w = world(on);
  const ui = await open($);
  expect(rows(await ui.drawn()).join("\n")).toContain("No tasks yet.");
  await ui.unmount();
  expect(w.lists).not.toContain(LIST);
});

test("without the task tools the pane says OMCA requires them and what keeps them off", async ($, on) => {
  const w = world(on);
  w.tools = ["Bash", "Read"];
  const ui = await open($);
  expect(spreadRows(await ui.drawn()).join(" ")).toContain(TASK_TOOLS_OFF);
  await ui.unmount();
});

const many = (count: number): Fields[] => Array.from({ length: count }, (_, index) => ({ id: String(index + 1), subject: `Step ${index + 1}`, description: `About step ${index + 1}.` }));

test("a list too long for the pane windows it: cues count tasks, Down carries the window, and no heading is left alone at the bottom", async ($, on) => {
  const tasks = many(20).map((task, index) => (index >= 6 && index < 12 ? { ...task, blockedBy: ["1"] } : task));
  world(on, filesOf(...tasks));
  const ui = await open($, SHORT);
  const first = await shown(ui);
  expect(first).toContain("○  #1  Step 1");
  expect(first.some((line) => /^↓ \d+ more$/.test(line))).toBe(true);
  expect(first.some((line) => /^↑ \d+ more$/.test(line))).toBe(false);
  expect(first.filter((line) => line !== "").at(-1)).toBe("↑↓ move  ⏎ open  esc close");
  const { bodyRows } = pane("terminal", SHORT).props.scroll;
  const down = { requestId: "tasklist", plugin: "oh-my-claudeagent", component: "Pane", offset: 0, by: 1, bodyRows, contentRows: bodyRows + 1, origin: { kind: "person" } } as const;
  for (let press = 0; press < 40; press += 1) {
    await $.ui.scroll(down);
    const listed = (await shown(ui)).filter((line) => line !== "").slice(0, -1);
    expect(listed.at(-1)).not.toMatch(RULE);
    const below = listed.at(-1)?.startsWith("↓") === true ? listed.at(-2) : undefined;
    if (below !== undefined) expect(below).not.toMatch(RULE);
  }
  const end = await shown(ui);
  expect(end.some((line) => /^↑ \d+ more$/.test(line))).toBe(true);
  expect(end.some((line) => /^↓ \d+ more$/.test(line))).toBe(false);
  expect(end.join("\n")).toContain("#12  Step 12");
  await ui.unmount();
});

test("a scroll of the OMCA pane leaves the task list's window where it is", async ($, on) => {
  world(on, filesOf(...many(20)));
  on("ui.scroll", () => ({}));
  await $.command.run(run(""));
  const ui = await open($, SHORT);
  const before = rows(await ui.drawn());
  const { bodyRows } = pane("terminal", SHORT).props.scroll;
  await $.ui.scroll({ requestId: "omca", component: "Pane", offset: 0, by: 1, bodyRows, contentRows: bodyRows + 1, origin: { kind: "person" } });
  await ui.redraw();
  expect(rows(await ui.drawn())).toEqual(before);
  await ui.unmount();
});

test("a pane too short for one item with its cue still draws a task", async ($, on) => {
  world(on, filesOf(...many(6)));
  const ui = await open($, { columns: 160, rows: 7, placement: "dock" });
  expect(rows(await ui.drawn()).join("\n")).toContain("#");
  await ui.unmount();
});

test("every row fits the pane at every size", async ($, on) => {
  world(
    on,
    filesOf(
      ...WORK,
      { id: "5", subject: "A subject long enough to run past every width the pane is ever drawn at, with 日本語 in it too", owner: "a-very-long-owner-name-for-the-aside", description: "D".repeat(300) },
      { id: "6", subject: "Given up", metadata: { blocked: "B".repeat(300), run: "R".repeat(300) } },
      { id: "7", subject: "Final check", blockedBy: ["2", "3", "4", "5"], metadata: { final: true, run: "R".repeat(300) } },
    ),
  );
  for (const size of SIZES) {
    const ui = await open($, size);
    for (const line of rows(await ui.drawn())) expect(displayWidth(line.trimEnd())).toBeLessThanOrEqual(usableColumns(bodyColumns(size)));
    await ui.unmount();
  }
});

test("a remote surface draws every task", async ($, on) => {
  const w = world(on, filesOf(...many(30)));
  w.surfaces = ["desktop"];
  await $.command.run(tasklist());
  const ui = await $.ui.mount({ ...pane("desktop", DOCK), requestId: "tasklist" });
  for (const n of [1, 15, 30]) expect(await ui.find({ key: `task-${n}` })).toBeDefined();
  await ui.unmount();
});

test("Done folds into one rule row with its count, d shows and hides it, and a list with nothing else left shows it open", async ($, on) => {
  world(on, filesOf(...WORK, { id: "5", subject: "Pick the library", status: "completed" }));
  const ui = await open($);
  expect(await shown(ui)).toContain("Done ✓ 2 ─ d: show ─");
  expect((await shown(ui)).join("\n")).not.toContain("Map the auth flow");
  await ui.press({ key: "d" });
  const opened = await shown(ui);
  const at = opened.indexOf("Done ✓ 2 ─ d: hide ─");
  expect(opened.slice(at + 1, at + 3)).toEqual(["✓ #1  Map the auth flow", "✓ #5  Pick the library"]);
  await ui.press({ key: "fold-done" });
  expect((await shown(ui)).join("\n")).not.toContain("Map the auth flow");
  await ui.unmount();
});

test("a list with nothing left but done tasks draws them under an open Done rule with no key for it", async ($, on) => {
  world(on, filesOf({ id: "1", subject: "Map", status: "completed" }, { id: "2", subject: "Port", status: "completed" }));
  const ui = await open($);
  const lines = await shown(ui);
  const at = lines.indexOf("Done ✓ 2 ─");
  expect(lines.slice(at + 1, at + 3)).toEqual(["✓ #1  Map", "✓ #2  Port"]);
  expect(lines.at(-1)).toBe("↑↓ move  ⏎ open  esc close");
  expect(await ui.find({ key: "d" })).toBeUndefined();
  await ui.unmount();
});

test("the run with work left is drawn in full, and every other run and the tasks in none fold to one row each", async ($, on) => {
  world(
    on,
    filesOf(
      { id: "1", subject: "Old port", status: "completed", metadata: { run: "old" } },
      { id: "2", subject: "Old docs", status: "completed", metadata: { run: "old" } },
      { id: "3", subject: "New port", status: "in_progress", metadata: RUN },
      { id: "4", subject: "Loose end" },
    ),
  );
  const ui = await open($);
  const lines = await shown(ui);
  expect(lines[0]).toBe("auth-rewrite  0 of 1 done");
  expect(lines).toContain("old 2 of 2 done ─ show ─");
  expect(lines).toContain("No run 0 of 1 done ─ show ─");
  expect(lines.join("\n")).not.toContain("Old port");
  await ui.press({ key: "fold-run-old" });
  const opened = await shown(ui);
  expect(opened).toContain("old 2 of 2 done ─ hide ─");
  expect(opened).toContain("✓ #1  Old port");
  await ui.unmount();
});

test("a page's links open the task they name, n and p step through the list's order, and b goes back to the row last shown", async ($, on) => {
  const w = world(on, filesOf(...WORK));
  const ui = await open($);
  await ui.press({ key: "task-2" });
  await ui.press({ key: "link-2-3" });
  expect(spreadRows(await ui.drawn()).map(norm)[0]).toBe("#3 Add the migration");
  expect(spreadRows(await ui.drawn()).map(norm)).toContain("◐ #2  Port the parser");
  await ui.press({ key: "p" });
  expect(spreadRows(await ui.drawn()).map(norm)[0]).toBe("#4 Update the docs");
  await ui.press({ key: "n" });
  await ui.press({ key: "n" });
  expect(spreadRows(await ui.drawn()).map(norm)[0]).toBe("#1 Map the auth flow");
  await ui.press({ key: "b" });
  expect(await shown(ui)).toContain("✓ #1  Map the auth flow");
  await w.clock.settle();
  expect(focusRequests(w.logs).at(-1)).toBe("task-1");
  await ui.unmount();
});

const FINAL_RUN: readonly Fields[] = [
  { id: "1", subject: "Port", status: "completed", metadata: RUN },
  { id: "2", subject: "Verify", blockedBy: ["1"], metadata: { ...RUN, final: true } },
];

const verdict = (taskId: string, exitCode: number, snippet: string) => ({ type: "final_verification", command: "just ci", exit_code: exitCode, output_snippet: snippet, timestamp: "2026-11-07T10:05:00Z", task_id: taskId });

test("the final task's page shows the newest verdict naming it, read from the ledger as the page opens", async ($, on) => {
  world(on, { ...filesOf(...FINAL_RUN), [LEDGER]: JSON.stringify({ entries: [verdict("2", 1, "2 failed"), verdict("9", 0, "other run"), verdict("2", 0, "all 412 passed\nmore")] }) });
  const ui = await open($);
  await ui.press({ key: "task-2" });
  const lines = spreadRows(await ui.drawn()).map(norm);
  expect(lines[1]).toBe("◆ Ready · final");
  const at = lines.indexOf("Verdict ─");
  expect(lines.slice(at + 1, at + 3)).toEqual([`✓ Passed · exit 0 · ${local("2026-11-07T10:05:00Z")}`, "all 412 passed"]);
  expect(at).toBeLessThan(lines.indexOf("Waits on ─"));
  await ui.unmount();
});

test("a final task no verdict names says so", async ($, on) => {
  world(on, filesOf(...FINAL_RUN));
  const ui = await open($);
  await ui.press({ key: "task-2" });
  expect(spreadRows(await ui.drawn()).map(norm)).toContain("No verdict names #2 yet");
  await ui.unmount();
});

test("the ASCII tier draws the list and a page in ASCII alone", async ($, on) => {
  world(on, filesOf(...WORK, { id: "5", subject: "Call", metadata: { blocked: "vendor down" } }, { id: "6", subject: "Verify", blockedBy: ["2", "3"], metadata: { final: true } }), {}, { OMCA_GLYPHS: "ascii" });
  const ui = await open($);
  const lines = rows(await ui.drawn()).map((line) => line.trimEnd());
  for (const line of lines) expect(isAscii(line)).toBe(true);
  expect(lines.map(norm)).toContain("= #6  Verify  <- 2 open");
  await ui.press({ key: "task-3" });
  for (const line of spreadRows(await ui.drawn())) expect(isAscii(line.trimEnd())).toBe(true);
  await ui.unmount();
});
