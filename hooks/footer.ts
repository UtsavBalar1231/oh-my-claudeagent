import { ledgerCoversSlot } from "../src/core/evidence.ts";
import { footerLine } from "../src/core/footer.ts";
import { LEDGER, statusPath, verificationOf } from "../src/core/omca-paths.ts";
import { glyphs, isAsciiRequested } from "../src/core/ui-kit.ts";
import type { Features } from "./dispatch.ts";
import { type Host, reason } from "./host.ts";

async function unloggedSince(host: Host, startMs: number): Promise<string | null> {
  const [root, sessionId] = await Promise.all([host.session.root(), host.session.id()]);
  const statusFile = statusPath(root, sessionId);
  if (statusFile === undefined || !(await host.fs.exists(statusFile))) return null;
  const slot = verificationOf(JSON.parse(await host.fs.read(statusFile)));
  if (slot === null || slot.at < Math.floor(startMs / 1000)) return null;
  const ledgerPath = `${root}/${LEDGER}`;
  const ledgerSeconds = (await host.fs.exists(ledgerPath))
    ? Math.floor((await host.fs.stat(ledgerPath)).mtimeMs / 1000)
    : 0;
  return ledgerCoversSlot(ledgerSeconds, slot.at) ? null : slot.command;
}

export const footer: Features = {
  "turn.start": {
    async pre(host, e) {
      const [usage, at] = await Promise.all([host.session.usage(), host.clock.now()]);
      await host.state.costSample.set({ turnId: e.turnId, usd: usage.cost?.usd ?? null, at });
      return undefined;
    },
  },
  "turn.complete": {
    async post(host, e, result) {
      if (e.agentId !== undefined) return undefined;
      const [{ value: sample }, usage, now, ascii] = await Promise.all([
        host.state.costSample.get(),
        host.session.usage(),
        host.clock.now(),
        host.env.OMCA_ASCII(),
      ]);
      const isSampled = sample?.turnId === e.turnId;
      const before = isSampled ? sample.usd : null;
      const after = usage.cost?.usd;
      // A five-hour or seven-day window means a subscription, where the engine's dollar figure is not what the account pays.
      const isSubscription = usage.rateLimits.some(({ kind }) => kind === "five_hour" || kind === "seven_day");
      let unlogged: string | null = null;
      try {
        unlogged = await unloggedSince(host, isSampled ? sample.at : now - e.durationMs);
      } catch (error) {
        host.log(`footer: cannot check this turn's verification: ${reason(error)}`);
      }
      const text = footerLine(
        {
          durationMs: e.durationMs,
          tokens:
            e.usage === undefined
              ? null
              : {
                  input: e.usage.input_tokens + e.usage.cache_read_input_tokens + e.usage.cache_creation_input_tokens,
                  output: e.usage.output_tokens,
                },
          costUsd: isSubscription || before === null || after === undefined ? null : after - before,
          unlogged,
        },
        glyphs(isAsciiRequested(ascii)),
      );
      return { ...result, text };
    },
  },
};
