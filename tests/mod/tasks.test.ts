import { type Engine, expect, type Plugin, test } from "claude-code/testing";
import { displayWidth, usableColumns } from "../../src/core/ui-kit.ts";
import { joinPath } from "../../src/core/path.ts";
import { TASK_TOOLS_OFF } from "../../src/core/native-tasks.ts";
import { bodyColumns, focusRequests, LAYOUTS, pane, POSIX, rows, run, SESSION, type Size, SIZES, spreadRows, usage, world, write } from "./world.ts";

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

const body = (lines: readonly string[]) => lines.slice(lines.findIndex((line) => line.includes("done")));

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

test("the list runs in the order the work runs, each open task with what it does", async ($, on) => {
  world(on, filesOf(...WORK));
  const ui = await open($);
  const lines = body(rows(await ui.drawn()).map((line) => line.trimEnd()));
  expect(lines[0]).toEndWith("1 of 4 done · 1 running");
  expect(lines.slice(1).map((line) => line.replace(/ {2,}/g, "  "))).toEqual([
    "Now",
    "◐ #2 Port the parser  executor",
    "  Move it to the helper.",
    "",
    "Next",
    "○ #4 Update the docs",
    "  Cover the helper.",
    "",
    "Waiting",
    "⊗ #3 Add the migration  waits on #2",
    "  Forward only.",
    "",
    "Done",
    "✓ #1 Map the auth flow",
  ]);
  await ui.unmount();
});

const RUN = { run: "auth-rewrite" };

test("the head row names the run beside the counts when the list has one", async ($, on) => {
  world(on, filesOf({ id: "1", subject: "Port", metadata: RUN }, { id: "2", subject: "Docs", status: "completed", metadata: RUN }));
  const ui = await open($);
  const head = rows(await ui.drawn())[0]?.trimEnd() ?? "";
  expect(head).toEndWith("1 of 2 done · auth-rewrite");
  await ui.unmount();
});

test("a list with no run names none", async ($, on) => {
  world(on, filesOf({ id: "1", subject: "Port" }));
  const plain = await open($);
  expect(rows(await plain.drawn())[0]?.trimEnd()).toEndWith("0 of 1 done");
  await plain.unmount();
});

test("a long run name gives way to the counts at the narrowest size", async ($, on) => {
  world(on, filesOf({ id: "1", subject: "Port", metadata: { run: "r".repeat(300) } }));
  const size: Size = { columns: 80, rows: 40, placement: "inline" };
  const ui = await open($, size);
  const head = rows(await ui.drawn())[0] ?? "";
  expect(head).toContain("0 of 1 done · rrr");
  expect(displayWidth(head.trimEnd())).toBeLessThanOrEqual(usableColumns(bodyColumns(size)));
  await ui.unmount();
});

test("a task closed as blocked shows why as its aside, and its page says it whole", async ($, on) => {
  const why = `the vendor API is down until ${"next ".repeat(30)}week`;
  world(on, filesOf({ id: "1", subject: "Call the vendor", owner: "executor", metadata: { blocked: why } }, { id: "2", subject: "Ship" }));
  const ui = await open($);
  const lines = rows(await ui.drawn()).map((line) => line.trimEnd().replace(/ {2,}/g, "  "));
  expect(lines[lines.indexOf("Waiting") + 1]).toStartWith("⊗ #1 Call the vendor  the vendor API");
  await ui.press({ key: "task-1" });
  const page = spreadRows(await ui.drawn()).map((line) => line.trimEnd());
  expect(page.join(" ")).toContain("Blocked");
  expect(page.join(" ").replace(/ +/g, " ")).toContain(why.replace(/ +/g, " "));
  await ui.unmount();
});

test("an in-progress task closed as blocked sits under Waiting and is not counted as running", async ($, on) => {
  world(on, filesOf({ id: "1", subject: "Call the vendor", status: "in_progress", metadata: { blocked: "vendor API down" } }, { id: "2", subject: "Ship" }));
  const ui = await open($);
  const page = rows(await ui.drawn());
  expect(page[0]?.trimEnd()).toEndWith("0 of 2 done");
  expect(page.join("\n")).not.toContain("running");
  const lines = page.map((line) => line.trimEnd());
  expect(lines[lines.indexOf("Waiting") + 1]).toContain("#1 Call the vendor");
  await ui.unmount();
});

test("a final task is marked final, before whatever else its aside says", async ($, on) => {
  const FINAL = { final: true };
  world(
    on,
    filesOf(
      { id: "1", subject: "Port", status: "in_progress" },
      { id: "2", subject: "Verify alone", metadata: FINAL },
      { id: "3", subject: "Verify after", blockedBy: ["1"], metadata: FINAL },
      { id: "4", subject: "Verify owned", status: "in_progress", owner: "executor", metadata: FINAL },
      { id: "5", subject: "Verify blocked", metadata: { ...FINAL, blocked: "no runner" } },
    ),
  );
  const ui = await open($);
  const lines = rows(await ui.drawn()).map((line) => line.trimEnd().replace(/ {2,}/g, "  "));
  expect(lines).toContain("○ #2 Verify alone  final");
  expect(lines).toContain("⊗ #3 Verify after  final · waits on #1");
  expect(lines).toContain("◐ #4 Verify owned  final · executor");
  expect(lines).toContain("⊗ #5 Verify blocked  no runner");
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

test("a summary draws its code spans", async ($, on) => {
  world(on, filesOf({ id: "1", subject: "Port", status: "in_progress", description: "Move `parseToken` over." }));
  const ui = await open($);
  expect(rows(await ui.drawn())).toContain("     Move parseToken over.");
  await ui.unmount();
});

test("the bar paints a waiting task like a todo one", async ($, on) => {
  world(on, filesOf({ id: "1", subject: "Port", status: "in_progress" }, { id: "2", subject: "Docs", blockedBy: ["1"] }, { id: "3", subject: "Tag", blockedBy: ["1"] }));
  const ui = await open($);
  const segments = (await ui.findAll({ type: "Text" })).filter((found) => /^[█▏▎▍▌▋▊▉]+$/.test(String(found.children?.[0]))).map((found) => found.props["color"]);
  expect(segments).not.toContain("warning");
  expect(segments.at(-1)).toBe("subtle");
  await ui.unmount();
});

test("Enter opens a task's page with its description, what it holds up and its metadata; b goes back to that row", async ($, on) => {
  const w = world(on, filesOf(...WORK));
  const ui = await open($);
  await ui.press({ key: "task-2" });
  const lines = spreadRows(await ui.drawn()).map((line) => line.trimEnd());
  expect(lines).toContain("◐ #2 Port the parser");
  expect(lines).toContain("Running · executor");
  expect(lines).toContain("Move it to the helper.");
  expect(lines).toContain("- Keep the errors");
  expect(lines).toContain("Holds up  #3 Add the migration");
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
  expect(lines).toContain("✓ #4 Update the docs");
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
  const lines = rows(await ui.drawn()).join("\n");
  expect(lines).toContain("#2 Second");
  expect(lines).toContain("#3 Third");
  expect(lines).not.toContain("#1 First");
  expect(lines).not.toContain("cleared its list");
  await ui.unmount();
});

test("a task Claude Code keeps to itself and a file that is not a task stay out of the list", async ($, on) => {
  world(on, { ...filesOf({ id: "1", subject: "Hidden", metadata: { _internal: true } }, { id: "2", subject: "Shown" }), [`${LIST}/3.json`]: "not json", [`${LIST}/.lock`]: "" });
  const ui = await open($);
  const lines = rows(await ui.drawn()).join("\n");
  expect(lines).toContain("0 of 1 done");
  expect(lines).toContain("#2 Shown");
  expect(lines).not.toContain("Hidden");
  await ui.unmount();
});

test("CLAUDE_CODE_TASK_LIST_ID names the list, cut to the characters Claude Code allows", async ($, on) => {
  world(on, Object.fromEntries([fileOf({ id: "1", subject: "Shared" }, `${HOME}/.claude/tasks/my-plan-1`)]), {}, { CLAUDE_CODE_TASK_LIST_ID: "my plan/1" });
  const ui = await open($);
  expect(rows(await ui.drawn()).join("\n")).toContain("#1 Shared");
  await ui.unmount();
});

for (const layout of LAYOUTS) {
  test(`the session's list is read under the config directory on ${layout.name}`, async ($, on) => {
    world(on, { [joinPath(layout.platform, layout.home, ".claude", "tasks", SESSION, "1.json")]: stored({ id: "1", subject: "Found it" }) }, {}, {}, layout);
    const ui = await open($);
    expect(rows(await ui.drawn()).join("\n")).toContain("#1 Found it");
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
  expect(lines).toContain("#4 Update the docs");
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
  const first = rows(await ui.drawn()).map((line) => line.trimEnd());
  expect(first).toContain("○ #1 Step 1");
  expect(first.some((line) => /^↓ \d+ more$/.test(line))).toBe(true);
  expect(first.some((line) => line.startsWith("↑"))).toBe(false);
  const { bodyRows } = pane("terminal", SHORT).props.scroll;
  const down = { requestId: "tasklist", plugin: "oh-my-claudeagent", component: "Pane", offset: 0, by: 1, bodyRows, contentRows: bodyRows + 1, origin: { kind: "person" } } as const;
  for (let press = 0; press < 40; press += 1) {
    await $.ui.scroll(down);
    const lines = rows(await ui.drawn()).map((line) => line.trimEnd());
    const shown = lines.filter((line) => line !== "" && line !== " ");
    expect(["Next", "Waiting", "Done"]).not.toContain(shown.at(-1));
    const below = shown.at(-1)?.startsWith("↓") === true ? shown.at(-2) : undefined;
    if (below !== undefined) expect(["Next", "Waiting", "Done"]).not.toContain(below);
  }
  const end = rows(await ui.drawn()).map((line) => line.trimEnd());
  expect(end.some((line) => line.startsWith("↑"))).toBe(true);
  expect(end.some((line) => line.startsWith("↓"))).toBe(false);
  expect(end.join("\n")).toContain("#12 Step 12");
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
