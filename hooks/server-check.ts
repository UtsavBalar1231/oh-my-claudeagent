import { BUN_FLOOR } from "../src/core/doctor-checks.ts";
import type { Features } from "./dispatch.ts";
import type { Host } from "./host.ts";

const SERVER = "omca";
const BUN_TIMEOUT_MS = 10_000;

async function hasBun(host: Host): Promise<boolean> {
  try {
    return (await host.process.run(["bun", "--version"], { timeoutMs: BUN_TIMEOUT_MS })).exitCode === 0;
  } catch {
    return false;
  }
}

const OFF = "its tools, guidance and stop gates are off for this session";

async function announceMissingServer(host: Host): Promise<undefined> {
  const server = await host.mcp.connect(SERVER);
  if (server.isConnected) return undefined;
  host.ui.say(
    (await hasBun(host))
      ? `the omca server is not connected (${server.message}), so ${OFF}. Run /mcp to see why.`
      : `bun is not on PATH, so the omca server did not start and ${OFF}. Install bun ${BUN_FLOOR} or later and restart Claude Code. In Claude Desktop or VS Code, put bun's folder (usually ~/.bun/bin) on the PATH the app starts with.`,
  );
  return undefined;
}

export const serverCheck: Features = {
  "session.start": { post: announceMissingServer },
};
