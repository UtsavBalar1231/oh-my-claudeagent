import { isSafeSessionId } from "../src/core/session-id.ts";
import type { Features } from "./dispatch.ts";
import type { Host } from "./host.ts";

// The marker proves the mod runs, so an unreadable manifest costs the version, not the marker.
async function pluginVersion(host: Host): Promise<string | null> {
  try {
    const manifest: unknown = JSON.parse(await host.fs.read(`${host.plugin.root}/.claude-plugin/plugin.json`));
    const version = typeof manifest === "object" && manifest !== null && "version" in manifest ? manifest.version : null;
    return typeof version === "string" ? version : null;
  } catch (error) {
    host.log(`mod-marker: cannot read the plugin version: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

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
  const { raw: _raw, ...options } = host.options;
  const marker = { written_at: now, version, options };
  await host.fs.write(`${root}/.omca/state/mod/${sessionId}.json`, `${JSON.stringify(marker)}\n`);
  return undefined;
}

export const modMarker: Features = {
  "session.start": { post: writeMarker },
  "turn.start": { pre: writeMarker },
};
