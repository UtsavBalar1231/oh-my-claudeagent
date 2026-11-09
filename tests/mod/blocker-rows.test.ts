import type { On, RenderSurface } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { judgeWrite } from "../../src/core/comments.ts";
import { FORCE_PUSH_REASON, GIT_REASON, REVIEW_REFUSED_REASON } from "../../src/core/destructive.ts";
import { noPassingVerdictReason, noVerdictReason, stayFinalReason } from "../../src/core/refusals.ts";
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
