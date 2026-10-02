import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveBoundPlan } from "../../src/core/boulder.ts";
import { setupBlock } from "../../src/core/doctor-checks.ts";
import type { Handler } from "./registry.ts";
import type { Session } from "./session-state.ts";
import { statusPath } from "./status-file.ts";

let template: string | undefined;

export function guidanceTemplate(): string {
  const root = process.env.CLAUDE_PLUGIN_ROOT || join(import.meta.dir, "..", "..");
  template ??= readFileSync(join(root, "templates", "claudemd.md"), "utf8");
  return template;
}

const isMissing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";

/** True while the user's CLAUDE.md still holds the 2.x block, which already carries this guidance. */
export function holdsSetupBlock(): boolean {
  const config = process.env.CLAUDE_CONFIG_DIR;
  const dir = config !== undefined && config !== "" ? config : join(process.env.HOME ?? homedir(), ".claude");
  try {
    return setupBlock(readFileSync(join(dir, "CLAUDE.md"), "utf8")) !== null;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function planTitle(root: string, sessionId: string): string | undefined {
  try {
    const registry: unknown = JSON.parse(readFileSync(join(root, ".omca", "state", "boulder.json"), "utf8"));
    const plan = resolveBoundPlan(registry, sessionId, true);
    return "plan_name" in plan && existsSync(plan.active_plan) ? `OMCA: ${plan.plan_name}` : undefined;
  } catch (error) {
    if (!isMissing(error)) console.error("omca: guidance could not read the plan registry for the session title:", error);
    return undefined;
  }
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
  const isHeldBack = session.isGuided || isResumed(root, session) || holdsSetupBlock();
  const context = isHeldBack ? undefined : `${guidanceTemplate()}\nSession ${session.id}`;
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
