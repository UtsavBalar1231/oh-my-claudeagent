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
// server is still off until a later ask finds it connected.
let isPinned = false;
let isAsking = false;

async function warn(host: Host, message: string): Promise<void> {
  isPinned = true;
  const bun = await hasBun(host);
  host.ui.say(
    bun
      ? `the omca server is not connected (${message}), so ${OFF}. Run /mcp to see why.`
      : `bun is not on PATH, so the omca server did not start and ${OFF}. Install bun ${BUN_FLOOR} or later and restart Claude Code. In Claude Desktop or VS Code, put bun's folder (usually ~/.bun/bin) on the PATH the app starts with.`,
  );
  host.ui.status(bun ? "server not connected, stop gates are off. Run /mcp" : "bun is not on PATH, so the server and stop gates are off");
}

// A hanging server holds this ask for its whole connect timeout with the prompt usable, so it counts
// as the one ask a turn's start must not add to: both would answer together and warn twice.
async function announceMissingServer(host: Host): Promise<undefined> {
  isAsking = true;
  try {
    const server = await host.mcp.connect(SERVER);
    if (server.isConnected) {
      isPinned = false;
      host.ui.status(undefined);
      return undefined;
    }
    await warn(host, server.message);
    return undefined;
  } finally {
    isAsking = false;
  }
}

// A server can die after it connected, and the engine raises nothing for a mod when it does, so
// every main turn asks. The answer is the session's state: a failed server stays failed until /mcp
// reconnects it. Asked from a timer, one at a time: a server that hangs while it connects must not
// hold up a turn.
function ask(host: Host): void {
  isAsking = true;
  host.clock.after(0, async () => {
    try {
      const server = await host.mcp.connect(SERVER);
      if (server.isConnected) {
        if (isPinned) host.ui.status(undefined);
        isPinned = false;
      } else if (!isPinned) {
        await warn(host, server.message);
      }
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
      if (!isAsking && e.agentId === undefined) ask(host);
      return undefined;
    },
  },
};
