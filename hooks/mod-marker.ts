import { isSafeSessionId } from "../src/core/session-id.ts";
import type { Features } from "./dispatch.ts";
import { type Host, pluginVersion } from "./host.ts";

// An unreadable manifest costs the marker its version, not the marker itself.
async function writeMarker(host: Host): Promise<undefined> {
  const [root, sessionId, now, version] = await Promise.all([
    host.session.root(),
    host.session.id(),
    host.clock.now(),
    pluginVersion(host),
  ]);
  if (!isSafeSessionId(sessionId)) {
    host.log(`mod-marker: the session id ${JSON.stringify(sessionId)} cannot name a file`);
    return undefined;
  }
  const marker = { written_at: now, version, options: host.options };
  await host.fs.write(`${root}/.omca/state/mod/${sessionId}.json`, `${JSON.stringify(marker)}\n`);
  return undefined;
}

export const modMarker: Features = {
  "session.start": { post: writeMarker },
  "turn.start": { pre: writeMarker },
};
