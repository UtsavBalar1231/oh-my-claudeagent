import { isHookDisabled } from "../../src/core/kill-switch.ts";
import type { Handler } from "./registry.ts";
import { markerWrittenAt } from "./status-file.ts";

export const MOD_NOT_RUNNING =
  "The OMCA mod is not running in this session, so its Bash guard, band and pane are off. Run /plugin and check that it is listed under mods active. An organization policy, Anthropic remotely, or three worker crashes turn mods off.";

// The mod marks the session the client launched with at session.start, before any prompt. A
// session that /clear starts is marked only at its first turn.start, which lands after this
// hook, so it cannot be told from a missing mod here. The launch session is the one the
// server's own environment names, because /clear keeps that value.
export const handle: Handler = (_payload, { root, session }) => {
  if (session === undefined || session.isModChecked === true) return undefined;
  if (session.id !== process.env.CLAUDE_CODE_SESSION_ID) return undefined;
  session.isModChecked = true;
  if (isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "mod-notice")) return undefined;
  if (markerWrittenAt(root, session.id) === undefined) return { systemMessage: MOD_NOT_RUNNING };
  return undefined;
};
