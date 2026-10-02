import { isPlanPath } from "./plan-path.ts";
import { inputText } from "./tool-input.ts";

const PLAN_HEADING = /^## (?:TODOs|Work Objectives)/m;
const AGENT_PLAN_NAME = /^[^/]+-agent-[^/]+\.md$/;
const NUMBERED_TASK = /^- \[[ x]\] \d+\./m;

/**
 * The deny reason for a Write or Edit that gives a plan file no numbered `- [ ] N.` or `- [x] N.` task, or
 * undefined. A Write is judged on its `content`, an Edit on its `new_string`.
 */
export function planWriteDenial(tool: string, input: unknown): string | undefined {
  if (tool !== "Write" && tool !== "Edit") return undefined;
  const filePath = inputText(input, "file_path");
  if (!isPlanPath(filePath)) return undefined;
  const body = inputText(input, tool === "Write" ? "content" : "new_string");
  // An Edit replaces part of a plan, so only one that rewrites a plan heading is judged as a whole plan.
  const isNamedPlan = tool === "Write" && AGENT_PLAN_NAME.test(filePath.slice(filePath.lastIndexOf("/") + 1));
  if (!(PLAN_HEADING.test(body) || isNamedPlan) || NUMBERED_TASK.test(body)) return undefined;
  return `[PLAN-CHECKBOX-VERIFY] Plan file ${filePath} has no numbered task checkbox. Write each task as \`- [ ] 1. <task>\`; plan progress and the Stop hooks count only numbered checkboxes.`;
}
