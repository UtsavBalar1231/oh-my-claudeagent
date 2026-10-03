import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveBoundPlan } from "../../src/core/boulder.ts";
import { nextTaskLabel } from "../../src/core/checkboxes.ts";
import { hasCode } from "../io.ts";
import { pluginRoot } from "../plugin-root.ts";
import type { Handler } from "./registry.ts";
import type { Session } from "./session-state.ts";
import { registryPath, statusPath } from "./status-file.ts";

let template: string | undefined;

export function guidanceTemplate(): string {
  template ??= readFileSync(join(pluginRoot(), "templates", "claudemd.md"), "utf8");
  return template;
}

type BoundPlan = { name: string; path: string; content: string };

function readBoundPlan(root: string, sessionId: string): BoundPlan | undefined {
  try {
    const registry: unknown = JSON.parse(readFileSync(registryPath(root), "utf8"));
    const plan = resolveBoundPlan(registry, sessionId, true);
    if (!("plan_name" in plan)) return undefined;
    return { name: plan.plan_name, path: plan.active_plan, content: readFileSync(plan.active_plan, "utf8") };
  } catch (error) {
    if (!hasCode(error, "ENOENT")) console.error("omca: guidance could not read this session's bound plan:", error);
    return undefined;
  }
}

const planContext = ({ name, path, content }: BoundPlan): string =>
  [
    `[ACTIVE PLAN] ${name}: ${path}`,
    `[NEXT TASK] ${nextTaskLabel(content) ?? "None open: every numbered task is checked."}`,
    `[NOTEPAD] Record discoveries, decisions and blockers with notepad_write('${name}', section, content); the sections are learnings, issues, decisions and problems.`,
  ].join("\n");

/** The template, then the session's id and its bound plan when there is a session to name. */
export function guidanceContext(root: string, sessionId: string | undefined): string {
  if (sessionId === undefined) return guidanceTemplate();
  const plan = readBoundPlan(root, sessionId);
  return [guidanceTemplate(), `Session ${sessionId}`, ...(plan === undefined ? [] : [planContext(plan)])].join("\n");
}

function planTitle(root: string, sessionId: string): string | undefined {
  const plan = readBoundPlan(root, sessionId);
  return plan === undefined ? undefined : `OMCA: ${plan.name}`;
}

// `claude --resume` keeps the session id but starts a new server, whose first hook call for the
// session finds the status file an earlier process wrote. This process has stamped the session
// once any dispatch for it finished (after /clear, the SessionStart call does), and the stamp
// runs after the handlers, so the guidance's first look still sees only an earlier process's file.
const isResumed = (root: string, session: Session): boolean =>
  session.stampedAt === undefined && existsSync(statusPath(root, session.id));

export const handle: Handler = (payload, { root, now, session }) => {
  if (session === undefined) return;
  session.promptAt = now;
  const isHeldBack = session.isGuided || isResumed(root, session);
  const context = isHeldBack ? undefined : guidanceContext(root, session.id);
  session.isGuided = true;
  // A typed slash command raises UserPromptExpansion before UserPromptSubmit, and only
  // UserPromptSubmit can set the title, so the title waits for the session's first one.
  let title: string | undefined;
  if (payload.event === "UserPromptSubmit" && !session.isTitleChecked) {
    session.isTitleChecked = true;
    if (!payload.session_title) title = planTitle(root, session.id);
  }
  if (context === undefined && title === undefined) return;
  return {
    hookSpecificOutput: {
      hookEventName: payload.event,
      ...(context !== undefined && { additionalContext: context }),
      ...(title !== undefined && { sessionTitle: title }),
    },
  };
};
