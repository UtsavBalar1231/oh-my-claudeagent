import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pluginRoot } from "../plugin-root.ts";
import type { Handler } from "./registry.ts";
import type { Session } from "./session-state.ts";
import { type OpenRun, readOpenRun, statusPath } from "./status-file.ts";

let template: string | undefined;

export function guidanceTemplate(): string {
  template ??= readFileSync(join(pluginRoot(), "templates", "claudemd.md"), "utf8");
  return template;
}

export const activeRunLine = ({ name, open, next }: OpenRun): string => `[ACTIVE RUN] ${name}: ${open.length} open, next #${next.id} ${next.subject}`;

const runContext = (run: OpenRun): string =>
  [
    activeRunLine(run),
    `[NOTEPAD] Record discoveries, decisions and blockers with notepad_write('${run.name}', section, content); the sections are learnings, issues, decisions and problems.`,
  ].join("\n");

const contextFor = (sessionId: string, run: OpenRun | undefined): string =>
  [guidanceTemplate(), `Session ${sessionId}`, ...(run === undefined ? [] : [runContext(run)])].join("\n");

/** The template, then the session's id and its open run when there is a session to name. */
export function guidanceContext(root: string, sessionId: string | undefined): string {
  return sessionId === undefined ? guidanceTemplate() : contextFor(sessionId, readOpenRun(root, sessionId, { atPrompt: true }));
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
  // A typed slash command raises UserPromptSubmit before UserPromptExpansion, and only
  // UserPromptSubmit can set the title, so the title goes out with the session's first one.
  const isTitleDue = payload.event === "UserPromptSubmit" && !session.isTitleChecked;
  if (isTitleDue) session.isTitleChecked = true;
  const wantsTitle = isTitleDue && !payload.session_title;
  const run = !isHeldBack || wantsTitle ? readOpenRun(root, session.id, { atPrompt: true }) : undefined;
  const context = isHeldBack ? undefined : contextFor(session.id, run);
  const title = wantsTitle && run !== undefined ? `OMCA: ${run.name}` : undefined;
  if (context === undefined && title === undefined) return;
  return {
    hookSpecificOutput: {
      hookEventName: payload.event,
      ...(context !== undefined && { additionalContext: context }),
      ...(title !== undefined && { sessionTitle: title }),
    },
  };
};
