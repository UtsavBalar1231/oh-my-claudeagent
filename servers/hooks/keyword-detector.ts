import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isHookDisabled } from "../../src/core/kill-switch.ts";
import { matchKeywordModes } from "../../src/core/keywords.ts";
import { isSafeId } from "../../src/core/session-id.ts";
import type { Handler } from "./registry.ts";
import { announceOnce } from "./session-state.ts";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function keywordTriggersEnabled(root: string, sessionId: unknown): boolean {
  if (typeof sessionId !== "string" || !isSafeId(sessionId)) return false;
  let text: string;
  try {
    text = readFileSync(join(root, ".omca", "state", "mod", `${sessionId}.json`), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  const marker: unknown = JSON.parse(text);
  return isRecord(marker) && isRecord(marker.options) && marker.options.enableKeywordTriggers === true;
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
