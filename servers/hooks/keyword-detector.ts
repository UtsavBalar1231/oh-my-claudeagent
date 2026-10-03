import { isHookDisabled } from "../../src/core/kill-switch.ts";
import { matchKeywordModes } from "../../src/core/keywords.ts";
import { isRecord } from "../../src/core/tool-input.ts";
import type { Handler } from "./registry.ts";
import { announceOnce } from "./session-state.ts";
import { readMarker } from "./status-file.ts";

function keywordTriggersEnabled(root: string, sessionId: unknown): boolean {
  if (typeof sessionId !== "string") return false;
  const options = readMarker(root, sessionId)?.options;
  return isRecord(options) && options.enableKeywordTriggers === true;
}

export const handle: Handler = (payload, { root, session }) => {
  if (isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "keyword-detector")) return;
  if (payload.agent_id || typeof payload.prompt !== "string") return;
  if (!keywordTriggersEnabled(root, payload.session_id)) return;
  const banners = matchKeywordModes(payload.prompt)
    .filter(({ name }) => announceOnce(session, name))
    .map(({ banner }) => banner);
  if (banners.length === 0) return;
  return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: banners.join("\n") } };
};
