import type { On, RenderSurface, ToolGroupCall } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { judgeWrite } from "../../src/core/comments.ts";
import { FORCE_PUSH_REASON, GIT_REASON, REVIEW_REFUSED_REASON } from "../../src/core/destructive.ts";
import { noPassingVerdictReason, noVerdictReason, stayFinalReason } from "../../src/core/refusals.ts";
import { unloggedReason } from "../../src/core/verification.ts";
import { INVALID_LEDGER_REASON } from "../../src/core/verification.ts";
import { PLUGIN, POSIX, SESSION, spreadRows, world } from "./world.ts";

const ENGINE_ROW = "engine row";
const LIST = `${POSIX.home}/.claude/tasks/${SESSION}`;
const DENIED = (tool: string) => `Error: Permission to use ${tool} denied by plugins oh-my-claudeagent, cc-plugin-privacy: `;
const HOOK_ERROR = (tool: string) => `Error: PreToolUse:${tool} hook error: `;

const task = (id: string, subject: string) =>
  JSON.stringify({ id, subject, description: "", activeForm: "", status: "pending", blocks: [], blockedBy: [], metadata: { run: "probe-run", final: true } });

function setup(on: On, env: Readonly<Record<string, string>> = {}) {
  world(
    on,
    {
      [`${LIST}/1.json`]: task("1", "Review the probe run"),
      [`${LIST}/7.json`]: task("7", "Review the run and record the final verification verdict"),
    },
    {},
    env,
  );
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  on("ui.render", ($, e) => $.ui.resolve(e).Text({ children: [ENGINE_ROW] }));
}

const start = ($: Engine) => $.session.start({ cwd: POSIX.root, surface: "terminal", isInteractive: true });

type Result = { tool?: string; output: unknown; isErrored?: boolean; isExpanded?: boolean | undefined };

async function rowsOf($: Engine, { tool = "Bash", output, isErrored = true, ...rest }: Result, { columns = 120, surface = "terminal" }: { columns?: number; surface?: RenderSurface } = {}) {
  const isExpanded = "isExpanded" in rest ? rest.isExpanded : false;
  const mounted = await $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: "ToolResult",
    requestId: "toolu_1",
    viewport: { columns, rows: 40 },
    props: { tool_use_id: "toolu_1", tool, output, isErrored, ...(isExpanded !== undefined && { isExpanded }) },
  });
  const rows = spreadRows(await mounted.drawn());
  await mounted.unmount();
  return rows;
}

const slop = judgeWrite("deny", { file_path: "/work/src/a.py", content: "# obviously the user name\nuser_name = input_value" }, new Map());
const slopReason = slop?.kind === "deny" ? slop.reason : "";

const REMEDY_AT_80 = "     delete the quoted comment, or rewrite it as the reason the code is the wa…";
const REMEDY_AT_120 = "     delete the quoted comment, or rewrite it as the reason the code is the way it is";

const ROWS: readonly { name: string; result: Result; at80: string[]; at120?: string[] }[] = [
  {
    name: "a guard deny",
    result: { output: `${DENIED("Bash")}${FORCE_PUSH_REASON}` },
    at80: ["  ⊗  OMCA guard refused · force push to the default branch", "     push to another branch, or ask the user to push"],
  },
  {
    name: "a refusal in the guard's dialog",
    result: { output: `${DENIED("Bash")}${REVIEW_REFUSED_REASON} OMCA held it as: force push to the default branch.` },
    at80: ["  ⊗  you refused this in the OMCA guard", "     Claude asks how to proceed"],
  },
  {
    name: "a final task kept final",
    result: { tool: "TaskUpdate", output: `${HOOK_ERROR("TaskUpdate")}${stayFinalReason("1", "probe-run")}` },
    at80: ["  ✗  #1 Review the probe run · stays the run's final task"],
  },
  {
    name: "a final task with no logged verdict",
    result: { tool: "TaskUpdate", output: `${HOOK_ERROR("TaskUpdate")}${noVerdictReason("7", "probe-run")}` },
    at80: ["  ✗  #7 Review the run and record the final… · final task has no logged verdict", "     record the verdict first with evidence_log"],
    at120: [
      "  ✗  #7 Review the run and record the final verification verdict · final task has no logged verdict",
      "     record the verdict first with evidence_log",
    ],
  },
  {
    name: "an unreadable ledger",
    result: { tool: "TaskUpdate", output: `${HOOK_ERROR("TaskUpdate")}${INVALID_LEDGER_REASON}` },
    at80: ["  ✗  evidence ledger invalid", "     log with the evidence_log tool, not manual file writes"],
  },
  {
    name: "a comment check deny",
    result: { tool: "Write", output: `${HOOK_ERROR("Write")}${slopReason}` },
    at80: ["  !  OMCA comment check held this write · obviously the user name", REMEDY_AT_80],
    at120: ["  !  OMCA comment check held this write · obviously the user name", REMEDY_AT_120],
  },
  {
    name: "a guard deny of a Monitor command",
    result: { tool: "Monitor", output: `${DENIED("Monitor")}${GIT_REASON}` },
    at80: ["  ⊗  OMCA guard refused · destructive git command", "     if the working tree is dirty, report and stop"],
  },
];

for (const { name, result, at80, at120 = at80 } of ROWS) {
  test(`${name} draws OMCA's row in place of the engine's error text, at 80 and 120 columns`, async ($, on) => {
    setup(on);
    await start($);
    expect(await rowsOf($, result, { columns: 80 })).toEqual(at80);
    expect(await rowsOf($, result, { columns: 120 })).toEqual(at120);
  });
}

test("a final task the task list does not hold is named by its id alone", async ($, on) => {
  setup(on);
  await start($);
  expect(await rowsOf($, { tool: "TaskUpdate", output: `${HOOK_ERROR("TaskUpdate")}${stayFinalReason("9", "probe-run")}` })).toEqual([
    "  ✗  #9 · stays the run's final task",
  ]);
});

test("ctrl+o, a client that does not say which view it draws, and a remote surface keep the engine's row", async ($, on) => {
  setup(on);
  await start($);
  const output = `${DENIED("Bash")}${FORCE_PUSH_REASON}`;
  expect(await rowsOf($, { output, isExpanded: true })).toEqual([ENGINE_ROW]);
  expect(await rowsOf($, { output, isExpanded: undefined })).toEqual([ENGINE_ROW]);
  expect(await rowsOf($, { output }, { surface: "desktop" })).toEqual([ENGINE_ROW]);
});

test("a failed command whose output quotes a reason, a held completion, a result that did not error and another tool keep the engine's row", async ($, on) => {
  setup(on);
  await start($);
  expect(await rowsOf($, { output: `Error: Exit code 1\nexpected "${FORCE_PUSH_REASON}" received ""` })).toEqual([ENGINE_ROW]);
  expect(await rowsOf($, { tool: "TaskUpdate", output: `${HOOK_ERROR("TaskUpdate")}${noPassingVerdictReason("1", "Review the probe run", "probe-run")}` })).toEqual([ENGINE_ROW]);
  expect(await rowsOf($, { output: `${DENIED("Bash")}${FORCE_PUSH_REASON}`, isErrored: false })).toEqual([ENGINE_ROW]);
  expect(await rowsOf($, { tool: "Read", output: `${DENIED("Read")}${FORCE_PUSH_REASON}` })).toEqual([ENGINE_ROW]);
});

test("the rows stay off before the session resolves and under OMCA_DISABLED_HOOKS=blocker-rows", async ($, on) => {
  setup(on, { OMCA_DISABLED_HOOKS: "bash-guard,blocker-rows" });
  const output = `${DENIED("Bash")}${FORCE_PUSH_REASON}`;
  expect(await rowsOf($, { output })).toEqual([ENGINE_ROW]);
  await start($);
  expect(await rowsOf($, { output })).toEqual([ENGINE_ROW]);
});

test("another hook's name in OMCA_DISABLED_HOOKS leaves the rows on", async ($, on) => {
  setup(on, { OMCA_DISABLED_HOOKS: "bash-guard" });
  await start($);
  expect(await rowsOf($, { output: `${DENIED("Bash")}${FORCE_PUSH_REASON}` })).toEqual([
    "  ⊗  OMCA guard refused · force push to the default branch",
    "     push to another branch, or ask the user to push",
  ]);
});

const call = (tool: string, input: unknown, output: unknown, isErrored = false): ToolGroupCall => ({
  tool_use_id: `toolu_${tool}`,
  tool,
  input,
  isRunning: false,
  isErrored,
  isInterrupted: false,
  output,
});

const pushRefused = call("Bash", { command: "git push --force origin main\necho done" }, `${DENIED("Bash")}${FORCE_PUSH_REASON}`, true);
const held = (taskId: string, error: string) => call("TaskUpdate", { taskId, status: "completed" }, { success: false, taskId, updatedFields: [], error: `TaskCompleted hook feedback:\n${error}` });

async function groupOf($: Engine, calls: ToolGroupCall[], { columns = 120, surface = "terminal", isExpanded = false }: { columns?: number; surface?: RenderSurface; isExpanded?: boolean } = {}) {
  const mounted = await $.ui.mount({ plugin: PLUGIN, surface, component: "ToolGroup", requestId: "group-1", viewport: { columns, rows: 40 }, props: { calls, isActive: false, isExpanded } });
  const tree = await mounted.drawn();
  await mounted.unmount();
  return { rows: spreadRows(tree), tree };
}

const REFUSED_ROWS = ["  ⊗  OMCA guard refused · force push to the default branch", "     push to another branch, or ask the user to push"];

test("a folded group of guard refusals draws each call's header and OMCA's rows, with the engine's top margin, at 80 and 120 columns", async ($, on) => {
  setup(on);
  await start($);
  const at80 = await groupOf($, [pushRefused], { columns: 80 });
  expect(at80.rows).toEqual(["● Bash(git push --force origin main)", ...REFUSED_ROWS]);
  expect((at80.tree as { props?: Record<string, unknown> }).props?.["marginTop"]).toBe(1);
  expect((await groupOf($, [pushRefused], { columns: 120 })).rows).toEqual(["● Bash(git push --force origin main)", ...REFUSED_ROWS]);
  const long = call("Bash", { command: `git push --force origin ${"a".repeat(80)}` }, `${DENIED("Bash")}${FORCE_PUSH_REASON}`, true);
  expect((await groupOf($, [long], { columns: 40 })).rows[0]).toBe("● Bash(git push --force origin aaaaaa…)");
});

test("a group with a call OMCA did not refuse keeps the engine's drawing", async ($, on) => {
  setup(on);
  await start($);
  const read = call("Read", { file_path: "/work/src/a.ts" }, { type: "text", file: { filePath: "/work/src/a.ts", content: "x", numLines: 1, startLine: 1, totalLines: 1 } });
  expect((await groupOf($, [pushRefused, read])).rows).toEqual([ENGINE_ROW]);
  expect((await groupOf($, [call("Bash", { command: "false" }, "Error: Exit code 1", true)])).rows).toEqual([ENGINE_ROW]);
});

test("a held completion appends OMCA's row under the group, after a receipt the group already draws", async ($, on) => {
  setup(on);
  await start($);
  const passed = call("Bash", { command: "just test" }, { stdout: "12 pass, 0 fail\n", stderr: "", interrupted: false, isImage: false });
  expect((await groupOf($, [passed, held("1", noPassingVerdictReason("1", "Review the probe run", "probe-run"))])).rows).toEqual([
    ENGINE_ROW,
    "  ⎿  ✓ just test · 12 pass, 0 fail",
    "  ✗  #1 Review the probe run · completion held: no passing verdict names it",
    "     review the run, then record the verdict with evidence_log",
  ]);
});

test("a held completion whose reason names no task takes the id from the call's input", async ($, on) => {
  setup(on);
  await start($);
  expect((await groupOf($, [held("7", unloggedReason({ command: "just test", at: 1_700_000_000, exit_code: 0 }))])).rows).toEqual([
    ENGINE_ROW,
    "  ✗  #7 Review the run and record the final verification verdi… · completion held: a verification ran and is not logged",
    "     log the real result with evidence_log, including a non-zero exit_code if it failed",
  ]);
});

test("an unfolded group and a remote surface keep the engine's drawing", async ($, on) => {
  setup(on);
  await start($);
  const holding = held("1", noPassingVerdictReason("1", "Review the probe run", "probe-run"));
  expect((await groupOf($, [pushRefused], { isExpanded: true })).rows).toEqual([ENGINE_ROW]);
  expect((await groupOf($, [holding], { isExpanded: true })).rows).toEqual([ENGINE_ROW]);
  expect((await groupOf($, [pushRefused], { surface: "desktop" })).rows).toEqual([ENGINE_ROW]);
  expect((await groupOf($, [holding], { surface: "desktop" })).rows).toEqual([ENGINE_ROW]);
});

test("OMCA_DISABLED_HOOKS=blocker-rows keeps the engine's group drawing", async ($, on) => {
  setup(on, { OMCA_DISABLED_HOOKS: "blocker-rows" });
  await start($);
  expect((await groupOf($, [pushRefused])).rows).toEqual([ENGINE_ROW]);
  expect((await groupOf($, [held("1", noPassingVerdictReason("1", "Review the probe run", "probe-run"))])).rows).toEqual([ENGINE_ROW]);
});
