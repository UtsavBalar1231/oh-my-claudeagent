import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nextTaskLabel } from "../../src/core/checkboxes.ts";
import { pluginRoot } from "../plugin-root.ts";
import type { Handler } from "./registry.ts";
import type { Session } from "./session-state.ts";
import { readBoundPlan, registryPath, statusPath } from "./status-file.ts";

let template: string | undefined;

export function guidanceTemplate(): string {
  template ??= readFileSync(join(pluginRoot(), "templates", "claudemd.md"), "utf8");
  return template;
}

type BoundPlan = { name: string; path: string; content: string };

function boundPlanOf(root: string, sessionId: string): BoundPlan | undefined {
  const read = readBoundPlan(root, sessionId);
  if (read.kind === "ok") return read.file && { name: read.name, path: read.path, content: read.file.content };
  if (read.kind === "corrupt") console.error(`omca: guidance: ${registryPath(root)} is not valid JSON, so no plan context is added`);
  if (read.kind === "unreadable") console.error(`omca: guidance could not read ${read.path} (${read.code}), so no plan context is added`);
  return undefined;
}

const planContext = ({ name, path, content }: BoundPlan): string =>
  [
    `[ACTIVE PLAN] ${name}: ${path}`,
    `[NEXT TASK] ${nextTaskLabel(content) ?? "None open: every numbered task is checked."}`,
    `[NOTEPAD] Record discoveries, decisions and blockers with notepad_write('${name}', section, content); the sections are learnings, issues, decisions and problems.`,
  ].join("\n");

const contextFor = (sessionId: string, plan: BoundPlan | undefined): string =>
  [guidanceTemplate(), `Session ${sessionId}`, ...(plan === undefined ? [] : [planContext(plan)])].join("\n");

/** The template, then the session's id and its bound plan when there is a session to name. */
export function guidanceContext(root: string, sessionId: string | undefined): string {
  return sessionId === undefined ? guidanceTemplate() : contextFor(sessionId, boundPlanOf(root, sessionId));
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
  session.isGuided = true;
  // A typed slash command raises UserPromptExpansion before UserPromptSubmit, and only
  // UserPromptSubmit can set the title, so the title waits for the session's first one.
  const isTitleDue = payload.event === "UserPromptSubmit" && !session.isTitleChecked;
  if (isTitleDue) session.isTitleChecked = true;
  const wantsTitle = isTitleDue && !payload.session_title;
  const plan = !isHeldBack || wantsTitle ? boundPlanOf(root, session.id) : undefined;
  const context = isHeldBack ? undefined : contextFor(session.id, plan);
  const title = wantsTitle && plan !== undefined ? `OMCA: ${plan.name}` : undefined;
  if (context === undefined && title === undefined) return;
  return {
    hookSpecificOutput: {
      hookEventName: payload.event,
      ...(context !== undefined && { additionalContext: context }),
      ...(title !== undefined && { sessionTitle: title }),
    },
  };
};
