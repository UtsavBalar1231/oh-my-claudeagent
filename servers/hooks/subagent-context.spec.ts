import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "./registry.ts";

const NOW = new Date(2026, 9, 2, 12).getTime();
const PLUGIN_ROOT = join(import.meta.dir, "..", "..");
const SESSION = "session-1";
const temps: string[] = [];

afterEach(() => {
  delete process.env.OMCA_DISABLED_HOOKS;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "omca-subagent-"));
  temps.push(dir);
  return dir;
}

const registry = (plans: Record<string, string>, bindings: Record<string, string> = {}) => ({
  plans: Object.fromEntries(Object.entries(plans).map(([name, file]) => [name, { active_plan: file }])),
  bindings: Object.fromEntries(Object.entries(bindings).map(([id, name]) => [id, { plan_name: name }])),
});

function writeBoulder(root: string, boulder: unknown): void {
  mkdirSync(join(root, ".omca", "state"), { recursive: true });
  writeFileSync(join(root, ".omca", "state", "boulder.json"), typeof boulder === "string" ? boulder : JSON.stringify(boulder));
}

function project(boulder?: unknown): string {
  const root = temp();
  if (boulder !== undefined) writeBoulder(root, boulder);
  return root;
}

function planFile(root: string, name = "my-plan.md"): string {
  const file = join(root, name);
  writeFileSync(file, "# Plan\n- task 1\n");
  return file;
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
  "\n[OUTPUT MANDATE] Your text response is the ONLY output the orchestrator receives. Tool call results and intermediate reasoning are NOT forwarded. Structure your response according to your agent's defined output format." +
  "\n[FILE TOOLS] Read files with the Read tool, not cat, head, tail, or sed -n in Bash: Read numbers the lines and pages a large file with offset and limit." +
  "\n[OMCA TOOLS] `evidence_log`, `boulder_progress` and `notepad_write` are always available. Load any other omca tool with ToolSearch first, by its full name: `select:mcp__plugin_oh-my-claudeagent_omca__ast_search`. A guessed prefix finds nothing.";
const EDITING_GUIDANCE =
  "\n[EDITS] Change an existing file with Edit, which touches only the lines that need it, rather than rewriting it with Write or a shell heredoc. Read the file before you Edit it, so old_string matches its current content." +
  "\n[VERIFICATION] Record each build, test, or lint run with evidence_log, including its real exit code. Write .omca/evidence/verification-evidence.json only through that tool, never by hand or through a shell redirect: the Stop and TaskCompleted gates read it as the audit trail." +
  "\n[PLAN SHA] When logging a final_verification entry, take plan_sha256 from boulder_progress for the active plan and pass it as evidence_log(..., plan_sha256=<plan_sha256>) so the Stop gate scopes evidence to this plan run.";
const ORCHESTRATING_GUIDANCE =
  "\n[ANTI-DUPLICATION] Once you delegate exploration to explore/librarian agents, do not perform the same search yourself. Avoid after delegating: manually grep/searching for the same information; re-doing research agents are handling; 'just quickly checking' the same files. Continue only with non-overlapping work. A background agent, the default in interactive sessions, answers the Agent call with a launch acknowledgement only, and its report arrives later in a task notification. Do not poll its output file or post holding messages while it runs." +
  "\n[TEAM CONTRACT] OMCA agents are thin wrappers over Claude-native subagents and agent teams. Use subagents when workers only need to report back. Use native agent teams when workers need the shared task list or direct teammate messaging.";
const WORKER_CONTRACT =
  "\n[YOU ARE A LEAF WORKER] Do this task yourself: do not delegate to other agents or wait on them. Guidance about waiting for background agents or ending a turn while agents run, whether it reaches you from memory, CLAUDE.md, or the output style, is for the orchestrator and does not apply to you." +
  "\n[NEVER STUB] Your final message is the whole deliverable: put your complete findings in it, never a bare status word or a note that you are waiting.";

const notepadLine = (name: string) =>
  `\n[NOTEPAD AVAILABLE] Plan: ${name}. Use notepad_write('${name}', section, content) to record discoveries. Sections: learnings, issues, decisions, problems. Each call appends, so earlier entries stay.`;

const planBlock = (file: string, name: string) =>
  `\n[ACTIVE PLAN] Refer to: ${file}` +
  `\nThe plan file at ${file} is READ-ONLY for you: the orchestrator flips its checkboxes after reviewing your report, so an edit here would record progress nobody verified. Record issues or decisions with notepad_write instead.` +
  notepadLine(name);

describe("the injected context, exactly", () => {
  test("a read-only worker gets the protocol, date, mandate, file tools and worker contract", async () => {
    expect(await contextOf(omca("explore"))).toBe(AUTONOMOUS_PROTOCOL + COMMON + WORKER_CONTRACT);
  });

  test("an editing worker also gets the editing guidance before the worker contract", async () => {
    expect(await contextOf(omca("executor"))).toBe(AUTONOMOUS_PROTOCOL + COMMON + EDITING_GUIDANCE + WORKER_CONTRACT);
  });

  test("no agent gets the cleanup-pass, minimal-code, date or ruler lines, whose home is the agent file or the platform", async () => {
    for (const type of ["executor", "hephaestus", "sisyphus", "explore"]) {
      const context = await contextOf(omca(type));
      for (const removed of ["[CLEANUP PASS]", "[MINIMAL CODE]", "[CURRENT DATE]", "───"]) expect(context).not.toContain(removed);
    }
  });

  test("sisyphus gets the planner protocol, editing and orchestrating guidance, and no worker contract", async () => {
    expect(await contextOf(omca("sisyphus"))).toBe(PLANNER_PROTOCOL + COMMON + EDITING_GUIDANCE + ORCHESTRATING_GUIDANCE);
  });

  test("prometheus gets only the orchestrating guidance", async () => {
    expect(await contextOf(omca("prometheus"))).toBe(PLANNER_PROTOCOL + COMMON + ORCHESTRATING_GUIDANCE);
  });

  test("a bound plan's lines sit between the file tools line and the worker contract", async () => {
    const root = project();
    const file = planFile(root);
    writeBoulder(root, registry({ "my-plan": file }, { [SESSION]: "my-plan" }));
    expect(await contextOf(omca("explore"), root)).toBe(AUTONOMOUS_PROTOCOL + COMMON + planBlock(file, "my-plan") + WORKER_CONTRACT);
  });

  test("an agent type that is absent is treated as an unlisted worker", async () => {
    expect(await contextOf(undefined)).toBe(AUTONOMOUS_PROTOCOL + COMMON + WORKER_CONTRACT);
  });

  test("a disabled subagent-context injects nothing", async () => {
    process.env.OMCA_DISABLED_HOOKS = "subagent-context";
    expect(await dispatch({ event: "SubagentStart", session_id: SESSION, agent_type: omca("explore") }, project(), NOW)).toEqual({});
  });
});

describe("plan context", () => {
  test("no boulder.json: plan context (READ-ONLY) is absent", async () => {
    expect(await contextOf(omca("explore"))).not.toContain("READ-ONLY");
  });

  test("a plan file that is missing drops the plan lines and keeps the notepad line", async () => {
    const root = project(registry({ "ghost-plan": "/tmp/nonexistent-plan-12345.md" }, { [SESSION]: "ghost-plan" }));
    const context = await contextOf(omca("explore"), root);
    expect(context).not.toContain("[ACTIVE PLAN]");
    expect(context).toContain("[NOTEPAD AVAILABLE]");
  });

  test("blocking questions: notepad sections list excludes questions", async () => {
    const root = project();
    writeBoulder(root, registry({ "my-plan": planFile(root) }, { [SESSION]: "my-plan" }));
    const context = await contextOf(omca("explore"), root);
    expect(context).toContain("learnings, issues, decisions, problems");
    expect(context).not.toContain("learnings, issues, decisions, problems, questions");
  });

  test("plan resolution: explicit binding for this session wins over other plans", async () => {
    const root = project();
    const planA = planFile(root, "plan-a.md");
    const planB = planFile(root, "plan-b.md");
    writeBoulder(root, registry({ "plan-a": planA, "plan-b": planB }, { [SESSION]: "plan-a" }));
    const context = await contextOf(omca("explore"), root);
    expect(context).toContain(`[ACTIVE PLAN] Refer to: ${planA}`);
    expect(context).not.toContain(planB);
  });

  test("plan resolution: no binding + single registered plan injects no plan context", async () => {
    const root = project();
    writeBoulder(root, registry({ "plan-a": planFile(root, "plan-a.md") }));
    const context = await contextOf(omca("explore"), root);
    expect(context).not.toContain("[ACTIVE PLAN]");
    expect(context).not.toContain("[NOTEPAD AVAILABLE]");
  });

  test("plan resolution: no binding + multiple plans injects no plan context", async () => {
    const root = project();
    const planA = planFile(root, "plan-a.md");
    const planB = planFile(root, "plan-b.md");
    writeBoulder(root, registry({ "plan-a": planA, "plan-b": planB }));
    const context = await contextOf(omca("explore"), root);
    expect(context).not.toContain("[ACTIVE PLAN]");
    expect(context).not.toContain(planA);
    expect(context).not.toContain(planB);
  });

  test("plan resolution: empty registry injects no plan context", async () => {
    const context = await contextOf(omca("explore"), project({ plans: {}, bindings: {} }));
    expect(context).not.toContain("[ACTIVE PLAN]");
    expect(context).not.toContain("[NOTEPAD AVAILABLE]");
  });

  test("an unparseable registry logs the failure and leaves the rest of the context", async () => {
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await contextOf(omca("explore"), project("{not json"))).toBe(AUTONOMOUS_PROTOCOL + COMMON + WORKER_CONTRACT);
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });
});

describe("guidance by role", () => {
  test("counter-instruction: librarian agent receives worker counter-instruction", async () => {
    expect(await contextOf(omca("librarian"))).toContain("[YOU ARE A LEAF WORKER]");
  });

  test("counter-instruction: hephaestus agent receives worker counter-instruction", async () => {
    expect(await contextOf(omca("hephaestus"))).toContain("[YOU ARE A LEAF WORKER]");
  });

  test("counter-instruction: momus agent receives worker counter-instruction (advisors are workers)", async () => {
    expect(await contextOf(omca("momus"))).toContain("[YOU ARE A LEAF WORKER]");
  });

  test("counter-instruction: oracle agent receives worker counter-instruction (advisors are workers)", async () => {
    expect(await contextOf(omca("oracle"))).toContain("[YOU ARE A LEAF WORKER]");
  });

  test("counter-instruction: metis agent receives worker counter-instruction and no anti-duplication", async () => {
    const context = await contextOf(omca("metis"));
    expect(context).toContain("[YOU ARE A LEAF WORKER]");
    expect(context).not.toContain("[ANTI-DUPLICATION]");
  });

});

describe("worker isolation", () => {
  const read = (path: string) => readFileSync(join(PLUGIN_ROOT, path), "utf8");
  const workerDefs = ["executor", "explore", "librarian", "multimodal-looker", "oracle", "momus", "hephaestus"].map((name) => `agents/${name}.md`);

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
