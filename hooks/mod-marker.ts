import { isSafeId } from "../src/core/session-id.ts";
import type { Features } from "./dispatch.ts";
import { type Host, pluginVersion } from "./host.ts";
import { hasTaskTools } from "./task-tools.ts";

// An unreadable manifest costs the marker its version, not the marker itself.
async function writeMarker(host: Host): Promise<undefined> {
  const [root, sessionId, now, version, taskTools, taskList] = await Promise.all([
    host.session.root(),
    host.session.id(),
    host.clock.now(),
    pluginVersion(host),
    hasTaskTools(host),
    host.env.CLAUDE_CODE_TASK_LIST_ID(),
  ]);
  if (!isSafeId(sessionId)) {
    host.log(`mod-marker: the session id ${JSON.stringify(sessionId)} cannot name a file`);
    return undefined;
  }
  const marker = { written_at: now, version, options: host.options, task_tools: taskTools, task_list: taskList ?? null };
  await host.fs.write(`${root}/.omca/state/mod/${sessionId}.json`, `${JSON.stringify(marker)}\n`);
  return undefined;
}

export const modMarker: Features = {
  "session.start": { post: writeMarker },
  "turn.start": { pre: (host, e) => (e.agentId === undefined ? writeMarker(host) : undefined) },
};
