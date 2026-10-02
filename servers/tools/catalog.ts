import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isSafeSessionId } from "../../src/core/session-id.ts";
import { findSession, latestSessionId } from "../hooks/session-state.ts";
import { projectRoot } from "../io.ts";
import type { Tool } from "../omca.ts";

export type Runtime =
  | { runtime: "ok" }
  | { runtime: "hooks_inactive" | "mod_absent"; runtime_reason: string };

const HOOKS_INACTIVE =
  "No OMCA settings hook has reached the server in this session, so hooks are off: `disableAllHooks` is set, or an organization policy sets `allowManagedHooksOnly`.";
const MOD_ABSENT =
  "The OMCA mod has not marked this session since the last prompt, so it is not running: an organization policy sets `allowManagedModsOnly`, the session started with `--safe-mode`, or the mod worker crashed three times and was unloaded.";

function markerWrittenAt(root: string, sessionId: string): number | undefined {
  if (!isSafeSessionId(sessionId)) return undefined;
  try {
    const marker: unknown = JSON.parse(readFileSync(join(root, ".omca", "state", "mod", `${sessionId}.json`), "utf8"));
    const at = typeof marker === "object" && marker !== null && "written_at" in marker ? marker.written_at : undefined;
    return typeof at === "number" ? at : undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function runtimeOf(root: string): Runtime {
  const sessionId = latestSessionId();
  if (sessionId === undefined) return { runtime: "hooks_inactive", runtime_reason: HOOKS_INACTIVE };
  const writtenAt = markerWrittenAt(root, sessionId);
  const promptAt = findSession(sessionId)?.promptAt ?? 0;
  return writtenAt !== undefined && writtenAt > promptAt
    ? { runtime: "ok" }
    : { runtime: "mod_absent", runtime_reason: MOD_ABSENT };
}

const root = projectRoot(process.cwd());

export const tools: Tool[] = [
  {
    name: "health_check",
    description:
      "Report whether OMCA's runtime is active in this session. `runtime` is `ok` when this session's settings hooks have reached the server and the OMCA mod has marked the session since the last prompt; otherwise it is `hooks_inactive` or `mod_absent`, and `runtime_reason` names the likely cause. The orchestration skills call this first and stop unless `runtime` is `ok`.",
    inputSchema: {
      type: "object",
      properties: {
        working_directory: { type: "string", default: "", description: "Project root (auto-detected from git)" },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    _meta: { "anthropic/searchHint": "whether OMCA's hooks and mod are running in this session" },
    call: () => JSON.stringify(runtimeOf(root)),
  },
];
