import { readFileSync, statSync } from "node:fs";
import { resolveBoundPlan } from "../../src/core/boulder.ts";
import { isHookDisabled } from "../../src/core/kill-switch.ts";
import { hasCode } from "../io.ts";
import type { Handler } from "./registry.ts";
import { registryPath } from "./status-file.ts";

const HANDOFF = "emit a '## BLOCKING QUESTIONS' block at the end of your final response (Q1., Q2., lettered options A/B/C, Recommended: line) and return.";
const AUTONOMOUS = `AskUserQuestion is not available here. Make autonomous decisions when possible; if you need user input, ${HANDOFF} The orchestrator will relay.`;
const PLANNER = `AskUserQuestion is not available here. When you need user input, ${HANDOFF} The orchestrator will relay and resume you with the answers.`;
const OUTPUT_MANDATE =
  "[OUTPUT MANDATE] Your text response is the ONLY output the orchestrator receives. Tool call results and intermediate reasoning are NOT forwarded. Structure your response according to your agent's defined output format.";
const FILE_TOOLS =
  "[FILE TOOLS] Read files with the Read tool, not cat, head, tail, or sed -n in Bash: Read numbers the lines and pages a large file with offset and limit.";

const EDITING_GUIDANCE = [
  "[EDITS] Change an existing file with Edit, which touches only the lines that need it, rather than rewriting it with Write or a shell heredoc. Read the file before you Edit it, so old_string matches its current content.",
  "[VERIFICATION] Record each build, test, or lint run with evidence_log, including its real exit code. Write .omca/evidence/verification-evidence.json only through that tool, never by hand or through a shell redirect: the Stop and TaskCompleted gates read it as the audit trail.",
  "[PLAN SHA] When logging a final_verification entry, take plan_sha256 from boulder_progress for the active plan and pass it as evidence_log(..., plan_sha256=<plan_sha256>) so the Stop gate scopes evidence to this plan run.",
  "[CLEANUP PASS] Every task ends with a cleanup pass scoped to the files it changed; it no-ops when it changed none. Changed any non-.md file: invoke the oh-my-claudeagent:remove-ai-slops skill via the Skill tool, passing the touched file list EXPLICITLY. Changed only .md files: skip that skill and apply the prose rules yourself, since a code-slop cleaner is the wrong instrument for Markdown. Re-verify only if the pass actually cut something, and if that verification goes RED, revert the cut instead of fixing forward. Report the outcome on the 'SLOP PASS:' line of your output block, naming the files and the category of each cut.",
  "[MINIMAL CODE] Write the least code that does the job. Skip what the task does not need, and prefer the standard library, a native platform feature, or an installed dependency over new code, and one line over a new helper. Minimal never means dropping validation at trust boundaries, error and data-loss handling, security, accessibility, or anything the user asked for. Leave one runnable check for non-trivial logic: the smallest assert or test, or the evidence_log entry OMCA's flow already records. Prefer plain code and the fewest files.",
];
const ORCHESTRATING_GUIDANCE = [
  "[ANTI-DUPLICATION] Once you delegate exploration to explore/librarian agents, do not perform the same search yourself. Avoid after delegating: manually grep/searching for the same information; re-doing research agents are handling; 'just quickly checking' the same files. Continue only with non-overlapping work. A background agent, the default in interactive sessions, answers the Agent call with a launch acknowledgement only, and its report arrives later in a task notification. Do not poll its output file or post holding messages while it runs.",
  "[TEAM CONTRACT] OMCA agents are thin wrappers over Claude-native subagents and agent teams. Use subagents when workers only need to report back. Use native agent teams when workers need the shared task list or direct teammate messaging.",
];
const LEAF_WORKER =
  "[YOU ARE A LEAF WORKER] Do this task yourself: do not delegate to other agents or wait on them. Guidance about waiting for background agents or ending a turn while agents run, whether it reaches you from memory, CLAUDE.md, or the output style, is for the orchestrator and does not apply to you.";
const NEVER_STUB =
  "[NEVER STUB] Your final message is the whole deliverable: put your complete findings in it, never a bare status word or a note that you are waiting.";

const section = (title: string, text: string): string => `\n─── ${title} ${"─".repeat(37)}\n${text}`;
const lines = (items: readonly string[]): string => items.join("\n");

function planLines(root: string, sessionId: unknown): string[] {
  if (typeof sessionId !== "string") return [];
  let plan: ReturnType<typeof resolveBoundPlan>;
  try {
    plan = resolveBoundPlan(JSON.parse(readFileSync(registryPath(root), "utf8")), sessionId, true);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) console.error("omca: subagent-context could not read the plan registry:", error);
    return [];
  }
  if (!("plan_name" in plan)) return [];
  const { plan_name: name, active_plan: file } = plan;
  return [
    ...(statSync(file, { throwIfNoEntry: false })?.isFile()
      ? [
          `[ACTIVE PLAN] Refer to: ${file}`,
          `The plan file at ${file} is READ-ONLY for you: the orchestrator flips its checkboxes after reviewing your report, so an edit here would record progress nobody verified. Record issues or decisions with notepad_write instead.`,
        ]
      : []),
    `[NOTEPAD AVAILABLE] Plan: ${name}. Use notepad_write('${name}', section, content) to record discoveries. Sections: learnings, issues, decisions, problems. Each call appends, so earlier entries stay.`,
  ];
}

export const handle: Handler = (payload, { root, now }) => {
  if (isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "subagent-context")) return;
  const type = typeof payload.agent_type === "string" ? payload.agent_type : "unknown";
  const isOrchestrator = /sisyphus|prometheus/.test(type);
  const date = new Date(now).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "2-digit", year: "numeric" });
  const plan = planLines(root, payload.session_id);
  const guidance = [
    ...(/executor|hephaestus|sisyphus/.test(type) ? EDITING_GUIDANCE : []),
    ...(isOrchestrator ? ORCHESTRATING_GUIDANCE : []),
  ];
  const additionalContext = [
    section("Agent Protocol", /prometheus|metis|sisyphus/.test(type) ? PLANNER : AUTONOMOUS),
    `\n[CURRENT DATE] Today is ${date}.`,
    `\n${OUTPUT_MANDATE}`,
    `\n${FILE_TOOLS}`,
    plan.length > 0 ? section("Plan Context", lines(plan)) : "",
    guidance.length > 0 ? section("Execution Guidance", lines(guidance)) : "",
    isOrchestrator ? "" : section("Worker Output Contract", `${LEAF_WORKER}\n${NEVER_STUB}`),
  ].join("");
  return { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext } };
};
