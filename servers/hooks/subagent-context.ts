import { omcaAgentName } from "../../src/core/agent-type.ts";
import { isHookDisabled } from "../../src/core/kill-switch.ts";
import type { Handler } from "./registry.ts";
import { readBoundPlan, registryPath } from "./status-file.ts";

const HANDOFF = "emit a '## BLOCKING QUESTIONS' block at the end of your final response (Q1., Q2., lettered options A/B/C, Recommended: line) and return.";
const AUTONOMOUS = `AskUserQuestion is not available here. Make autonomous decisions when possible; if you need user input, ${HANDOFF} The orchestrator will relay.`;
const PLANNER = `AskUserQuestion is not available here. When you need user input, ${HANDOFF} The orchestrator will relay and resume you with the answers.`;
const OUTPUT_MANDATE =
  "[OUTPUT MANDATE] Your text response is the ONLY output the orchestrator receives. Tool call results and intermediate reasoning are NOT forwarded. Structure your response according to your agent's defined output format.";
const FILE_TOOLS =
  "[FILE TOOLS] Read files with the Read tool, not cat, head, tail, or sed -n in Bash: Read numbers the lines and pages a large file with offset and limit.";
export const OMCA_TOOLS =
  "`evidence_log`, `boulder_progress` and `notepad_write` are always available. Load any other omca tool with ToolSearch first, by its full name: `select:mcp__plugin_oh-my-claudeagent_omca__ast_search`. A guessed prefix finds nothing.";

const EDITING_GUIDANCE = [
  "[EDITS] Change an existing file with Edit, which touches only the lines that need it, rather than rewriting it with Write or a shell heredoc. Read the file before you Edit it, so old_string matches its current content.",
  "[VERIFICATION] Record each build, test, or lint run with evidence_log, including its real exit code. Write .omca/evidence/verification-evidence.json only through that tool, never by hand or through a shell redirect: the Stop and TaskCompleted gates read it as the audit trail.",
  "[PLAN SHA] When logging a final_verification entry, take plan_sha256 from boulder_progress for the active plan and pass it as evidence_log(..., plan_sha256=<plan_sha256>) so the Stop gate scopes evidence to this plan run.",
];
const ORCHESTRATING_GUIDANCE = [
  "[ANTI-DUPLICATION] Once you delegate exploration to explorer/researcher agents, do not perform the same search yourself. Avoid after delegating: manually grep/searching for the same information; re-doing research agents are handling; 'just quickly checking' the same files. Continue only with non-overlapping work. A background agent, the default in interactive sessions, answers the Agent call with a launch acknowledgement only, and its report arrives later in a task notification. Do not poll its output file or post holding messages while it runs.",
  "[TEAM CONTRACT] OMCA agents are thin wrappers over Claude-native subagents and agent teams. Use subagents when workers only need to report back. Use native agent teams when workers need the shared task list or direct teammate messaging.",
];
const ORCHESTRATING = new Set(["orchestrator", "planner"]);
const PLANNING = new Set(["planner", "analyzer", "orchestrator"]);
const EDITING = new Set(["executor", "build-fixer", "orchestrator"]);
const LEAF_WORKER =
  "[YOU ARE A LEAF WORKER] Do this task yourself: do not delegate to other agents or wait on them. Guidance about waiting for background agents or ending a turn while agents run, whether it reaches you from memory, CLAUDE.md, or the output style, is for the orchestrator and does not apply to you.";
const NEVER_STUB =
  "[NEVER STUB] Your final message is the whole deliverable: put your complete findings in it, never a bare status word or a note that you are waiting.";

function planLines(root: string, sessionId: unknown): string[] {
  if (typeof sessionId !== "string") return [];
  const read = readBoundPlan(root, sessionId);
  if (read.kind === "corrupt") console.error(`omca: subagent-context: ${registryPath(root)} is not valid JSON, so no plan context is added`);
  if (read.kind === "unreadable") console.error(`omca: subagent-context could not read ${read.path} (${read.code}), so no plan context is added`);
  if (read.kind !== "ok") return [];
  const { name, path: file } = read;
  return [
    ...(read.file !== undefined
      ? [
          `[ACTIVE PLAN] Refer to: ${file}`,
          `The plan file at ${file} is READ-ONLY for you: the orchestrator flips its checkboxes after reviewing your report, so an edit here would record progress nobody verified. Record issues or decisions with notepad_write instead.`,
        ]
      : []),
    `[NOTEPAD AVAILABLE] Plan: ${name}. Use notepad_write('${name}', section, content) to record discoveries. Sections: learnings, issues, decisions, problems. Each call appends, so earlier entries stay.`,
  ];
}

export const handle: Handler = (payload, { root }) => {
  if (isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "subagent-context")) return;
  const type = typeof payload.agent_type === "string" ? payload.agent_type : "unknown";
  const name = omcaAgentName(type) ?? "";
  const isOrchestrator = ORCHESTRATING.has(name);
  const additionalContext = [
    PLANNING.has(name) ? PLANNER : AUTONOMOUS,
    OUTPUT_MANDATE,
    FILE_TOOLS,
    `[OMCA TOOLS] ${OMCA_TOOLS}`,
    ...planLines(root, payload.session_id),
    ...(EDITING.has(name) ? EDITING_GUIDANCE : []),
    ...(isOrchestrator ? ORCHESTRATING_GUIDANCE : [LEAF_WORKER, NEVER_STUB]),
  ].join("\n");
  return { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext } };
};
