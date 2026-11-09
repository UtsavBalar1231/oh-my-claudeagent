import { isHookDisabled } from "../../src/core/kill-switch.ts";
import { inputText } from "../../src/core/tool-input.ts";
import type { Handler } from "./registry.ts";

const WORKING = new Set(["in_progress", "completed"]);

// Kept in memory on purpose: `/clear` starts a session that must touch a task to pick the run up.
// Starting or closing a task is the touch: a planning session creates tasks and links them without taking the run on.
export const handle: Handler = (payload, { session }) => {
  if (session === undefined || isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "task-touch")) return;
  if (payload.tool_name === "TaskUpdate" && WORKING.has(inputText(payload.tool_input, "status"))) session.hasTouchedTask = true;
};
