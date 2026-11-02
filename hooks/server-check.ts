import { BUN_FLOOR } from "../src/core/doctor-checks.ts";
import type { Features } from "./dispatch.ts";
import { type Host, reason } from "./host.ts";

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

// The transcript line says why and how to fix it once, and scrolls away; the status line says the
// server is still off until it connects, so only a pinned session asks the engine again.
let isPinned = false;
let isAsking = false;

async function announceMissingServer(host: Host): Promise<undefined> {
  const server = await host.mcp.connect(SERVER);
  isPinned = !server.isConnected;
  if (server.isConnected) {
    host.ui.status(undefined);
    return undefined;
  }
  const bun = await hasBun(host);
  host.ui.say(
    bun
      ? `the omca server is not connected (${server.message}), so ${OFF}. Run /mcp to see why.`
      : `bun is not on PATH, so the omca server did not start and ${OFF}. Install bun ${BUN_FLOOR} or later and restart Claude Code. In Claude Desktop or VS Code, put bun's folder (usually ~/.bun/bin) on the PATH the app starts with.`,
  );
  host.ui.status(bun ? "server not connected, stop gates are off. Run /mcp" : "bun is not on PATH, so the server and stop gates are off");
  return undefined;
}

// Asked from a timer, one at a time: a server that hangs while it connects must not hold up a turn.
function askAgain(host: Host): void {
  isAsking = true;
  host.clock.after(0, async () => {
    try {
      if (!(await host.mcp.connect(SERVER)).isConnected) return;
      isPinned = false;
      host.ui.status(undefined);
    } catch (error) {
      host.log(`server-check: asking again failed: ${reason(error)}`);
    } finally {
      isAsking = false;
    }
  });
}

export const serverCheck: Features = {
  "session.start": { post: announceMissingServer },
  "turn.start": {
    pre(host, e) {
      if (isPinned && !isAsking && e.agentId === undefined) askAgain(host);
      return undefined;
    },
  },
};
