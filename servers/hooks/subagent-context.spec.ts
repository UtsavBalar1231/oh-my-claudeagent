import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "./registry.ts";

const NOW = new Date(2026, 9, 2, 12).getTime();
const PLUGIN_ROOT = join(import.meta.dir, "..", "..");
const SESSION = "session-1";
const configDir = process.env.CLAUDE_CONFIG_DIR;
const temps: string[] = [];

beforeEach(() => {
  process.env.CLAUDE_CONFIG_DIR = temp();
});

afterEach(() => {
  delete process.env.CLAUDE_CODE_TASK_LIST_ID;
  delete process.env.OMCA_DISABLED_HOOKS;
  if (configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = configDir;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "omca-subagent-"));
  temps.push(dir);
  return dir;
}

const project = (): string => temp();

function writeTasks(sessionId: string, ...tasks: readonly Record<string, unknown>[]): void {
  process.env.CLAUDE_CODE_TASK_LIST_ID = sessionId;
  const dir = join(String(process.env.CLAUDE_CONFIG_DIR), "tasks", sessionId);
  mkdirSync(dir, { recursive: true });
  for (const task of tasks) writeFileSync(join(dir, `${String(task.id)}.json`), JSON.stringify({ status: "pending", metadata: { run: "my-run" }, ...task }));
}

async function contextOf(agentType: string | undefined, root = project(), sessionId = SESSION): Promise<string> {
  const payload = { event: "SubagentStart", session_id: sessionId, agent_id: "agent-abc123", ...(agentType !== undefined && { agent_type: agentType }) };
  const output = await dispatch(payload, root, NOW);
  expect(output.hookSpecificOutput?.hookEventName).toBe("SubagentStart");
  return output.hookSpecificOutput?.additionalContext as string;
}

const omca = (name: string) => `oh-my-claudeagent:${name}`;

const AUTONOMOUS_PROTOCOL =
  "AskUserQuestion is not available here. Make autonomous decisions when possible; if you need user input, emit a '## BLOCKING QUESTIONS' block at the end of your final response (Q1., Q2., lettered options A/B/C, Recommended: line) and return. The orchestrator will relay.";
const PLANNER_PROTOCOL =
  "AskUserQuestion is not available here. When you need user input, emit a '## BLOCKING QUESTIONS' block at the end of your final response (Q1., Q2., lettered options A/B/C, Recommended: line) and return. The orchestrator will relay and resume you with the answers.";
const COMMON =
  "\n[OUTPUT MANDATE] Your final response is the deliverable; intermediate tool results are not forwarded. Return findings, evidence and remaining limits, keeping any markers your agent requires." +
  "\n[FILE TOOLS] Read files with the Read tool, not cat, head, tail, or sed -n in Bash: Read numbers the lines and pages a large file with offset and limit." +
  "\n[REFUSALS] When a permission check denies a call or the user declines it, that decides the outcome the call was after. Do not get there through another tool, command, path or host. Report what stays undone and carry on with the rest. Retry only when the denial's own message says to wait and try again." +
  "\n[OMCA TOOLS] `evidence_log` and `notepad_write` are always available. Load any other omca tool with ToolSearch first, by its full name: `select:mcp__plugin_oh-my-claudeagent_omca__ast_search`. A guessed prefix finds nothing.";
const EDITING_GUIDANCE =
  "\n[EDITS] Change an existing file with Edit, which touches only the lines that need it, rather than rewriting it with Write or a shell heredoc. Read the file before you Edit it, so old_string matches its current content." +
  "\n[VERIFICATION] Record each build, test, or lint run with evidence_log, including its real exit code. Write .omca/evidence/verification-evidence.json only through that tool, never by hand or through a shell redirect: the TaskCompleted gate reads it as the audit trail.";
const FINAL_TASK = "\n[FINAL TASK] A run's final task completes only after a passing final_verification entry names it: evidence_log(..., task_id=<its id>).";
const ORCHESTRATING_GUIDANCE =
  "\n[ANTI-DUPLICATION] Do not duplicate an active delegate's search. Continue non-overlapping work, then independently check its delivered findings. A background launch acknowledgement is not a result; wait for the actual task notification. Do not poll the child's transcript or send holding messages." +
  "\n[TEAM CONTRACT] OMCA agents are thin wrappers over Claude-native subagents and agent teams. Use subagents when workers only need to report back. Use native agent teams when workers need the shared task list or direct teammate messaging.";
const WORKER_CONTRACT =
  "\n[YOU ARE A LEAF WORKER] Do this task yourself: do not delegate to other agents or wait on them. Guidance about waiting for background agents or ending a turn while agents run, whether it reaches you from memory, CLAUDE.md, or the output style, is for the orchestrator and does not apply to you." +
  "\n[NEVER STUB] Your final message is the whole deliverable: put your complete findings in it, never a bare status word or a note that you are waiting.";

const RUN_BLOCK =
  "\n[ACTIVE RUN] my-run: 1 open, next #2 Say hello" +
  "\nRead the run's tasks with task_list and task_get, which work in every agent. Load them with ToolSearch: `select:mcp__plugin_oh-my-claudeagent_omca__task_list,mcp__plugin_oh-my-claudeagent_omca__task_get`." +
  "\nTask status is the orchestrator's: it completes each task after reviewing the report, so a TaskUpdate to completed from a worker would record progress nobody verified." +
  "\n[NOTEPAD AVAILABLE] Run: my-run. Return discoveries, issues and decisions for the primary to checkpoint; do not call notepad_write from this read-only assignment. Sections: learnings, issues, decisions, problems.";

describe("the injected context, exactly", () => {
  test("a read-only worker gets the protocol, date, mandate, file tools and worker contract", async () => {
    expect(await contextOf(omca("explorer"))).toBe(AUTONOMOUS_PROTOCOL + COMMON + WORKER_CONTRACT);
  });

  test("an editing worker also gets the editing guidance before the worker contract", async () => {
    expect(await contextOf(omca("executor"))).toBe(AUTONOMOUS_PROTOCOL + COMMON + EDITING_GUIDANCE + WORKER_CONTRACT);
  });

  test("no agent gets the cleanup-pass, minimal-code, date or ruler lines, whose home is the agent file or the platform", async () => {
    for (const type of ["executor", "build-fixer", "orchestrator", "explorer"]) {
      const context = await contextOf(omca(type));
      for (const removed of ["[CLEANUP PASS]", "[MINIMAL CODE]", "[CURRENT DATE]", "───"]) expect(context).not.toContain(removed);
    }
  });

  test("orchestrator gets the planner protocol, editing and orchestrating guidance, and no worker contract", async () => {
    expect(await contextOf(omca("orchestrator"))).toBe(PLANNER_PROTOCOL + COMMON + EDITING_GUIDANCE + FINAL_TASK + ORCHESTRATING_GUIDANCE);
  });

  test("only the orchestrator is told how to log the final verdict", async () => {
    expect(await contextOf(omca("orchestrator"))).toContain("[FINAL TASK]");
    for (const type of ["executor", "build-fixer", "planner", "explorer"]) expect(await contextOf(omca(type))).not.toContain("[FINAL TASK]");
  });

  test("planner gets only the orchestrating guidance", async () => {
    expect(await contextOf(omca("planner"))).toBe(PLANNER_PROTOCOL + COMMON + ORCHESTRATING_GUIDANCE);
  });

  test("an open run's lines sit between the file tools line and the worker contract", async () => {
    writeTasks(SESSION, { id: "1", subject: "Parse", status: "completed" }, { id: "2", subject: "Say hello" });
    expect(await contextOf(omca("explorer"))).toBe(AUTONOMOUS_PROTOCOL + COMMON + RUN_BLOCK + WORKER_CONTRACT);
  });

  test("an agent type that is absent is treated as an unlisted worker", async () => {
    expect(await contextOf(undefined)).toBe(AUTONOMOUS_PROTOCOL + COMMON + WORKER_CONTRACT);
  });

  test("a disabled subagent-context injects nothing", async () => {
    process.env.OMCA_DISABLED_HOOKS = "subagent-context";
    expect(await dispatch({ event: "SubagentStart", session_id: SESSION, agent_type: omca("explorer") }, project(), NOW)).toEqual({});
  });
});

describe("role lookup", () => {
  test("a bare name and the OMCA-prefixed name get the same role, and another prefix gets none", async () => {
    const planner = PLANNER_PROTOCOL + COMMON + ORCHESTRATING_GUIDANCE;
    expect(await contextOf("planner")).toBe(planner);
    expect(await contextOf(omca("planner"))).toBe(planner);
    expect(await contextOf("other:planner")).toBe(AUTONOMOUS_PROTOCOL + COMMON + WORKER_CONTRACT);
  });

  test("a role is matched by exact name, never by substring", async () => {
    expect(await contextOf(omca("planner-lite"))).toBe(AUTONOMOUS_PROTOCOL + COMMON + WORKER_CONTRACT);
  });
});

describe("run context", () => {
  test("no tasks: no run context", async () => {
    const context = await contextOf(omca("explorer"));
    expect(context).not.toContain("[ACTIVE RUN]");
    expect(context).not.toContain("[NOTEPAD AVAILABLE]");
  });

  test("a run with nothing open and tasks with no run add no run context", async () => {
    writeTasks(SESSION, { id: "1", subject: "Parse", status: "completed" }, { id: "2", subject: "Ad hoc", metadata: {} });
    expect(await contextOf(omca("explorer"))).toBe(AUTONOMOUS_PROTOCOL + COMMON + WORKER_CONTRACT);
  });

  test("blocking questions: notepad sections list excludes questions", async () => {
    writeTasks(SESSION, { id: "1", subject: "Parse" });
    const context = await contextOf(omca("explorer"));
    expect(context).toContain("learnings, issues, decisions, problems");
    expect(context).not.toContain("learnings, issues, decisions, problems, questions");
  });

  test("read-only workers relay checkpoints while editing workers may append them", async () => {
    writeTasks(SESSION, { id: "1", subject: "Parse" });
    const readonly = await contextOf(omca("explorer"));
    expect(readonly).toContain("primary to checkpoint");
    expect(readonly).not.toContain("Use notepad_write(");
    expect(await contextOf(omca("executor"))).toContain("Use notepad_write('my-run'");
  });

  test("another session's list is not this session's run", async () => {
    writeTasks("other-session", { id: "1", subject: "Parse" });
    process.env.CLAUDE_CODE_TASK_LIST_ID = "this-session";
    expect(await contextOf(omca("explorer"))).not.toContain("[ACTIVE RUN]");
  });
});

describe("guidance by role", () => {
  test("counter-instruction: researcher agent receives worker counter-instruction", async () => {
    expect(await contextOf(omca("researcher"))).toContain("[YOU ARE A LEAF WORKER]");
  });

  test("counter-instruction: build-fixer agent receives worker counter-instruction", async () => {
    expect(await contextOf(omca("build-fixer"))).toContain("[YOU ARE A LEAF WORKER]");
  });

  test("counter-instruction: reviewer agent receives worker counter-instruction (advisors are workers)", async () => {
    expect(await contextOf(omca("reviewer"))).toContain("[YOU ARE A LEAF WORKER]");
  });

  test("counter-instruction: architect agent receives worker counter-instruction (advisors are workers)", async () => {
    expect(await contextOf(omca("architect"))).toContain("[YOU ARE A LEAF WORKER]");
  });

  test("counter-instruction: analyzer agent receives worker counter-instruction and no anti-duplication", async () => {
    const context = await contextOf(omca("analyzer"));
    expect(context).toContain("[YOU ARE A LEAF WORKER]");
    expect(context).not.toContain("[ANTI-DUPLICATION]");
  });

});

describe("worker isolation", () => {
  const read = (path: string) => readFileSync(join(PLUGIN_ROOT, path), "utf8");
  const workerDefs = ["executor", "explorer", "researcher", "viewer", "architect", "reviewer", "build-fixer"].map((name) => `agents/${name}.md`);

  test("worker isolation: no bare barrier imperative in worker-visible surfaces", () => {
    for (const path of [...workerDefs, "output-styles/omca-default.md", "templates/claudemd.md"]) {
      expect({ path, found: /end response, wait|END the response while|Waiting for N more/i.test(read(path)) }).toEqual({ path, found: false });
    }
  });

  test("worker isolation: removed barrier section absent from executor.md", () => {
    expect(read("agents/executor.md")).not.toContain("## Background Agent Results");
  });

  test("worker isolation: SubagentStart injects the leaf-worker and never-stub contract", async () => {
    const context = await contextOf(omca("executor"));
    expect(context).toContain("[NEVER STUB]");
    expect(context).toContain("[YOU ARE A LEAF WORKER]");
  });
});
