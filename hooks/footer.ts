import { ledgerCoversSlot } from "../src/core/evidence.ts";
import { footerLine } from "../src/core/footer.ts";
import { isSafeSessionId } from "../src/core/session-id.ts";
import { glyphs, isAsciiRequested } from "../src/core/ui-kit.ts";
import { verificationOf } from "./band.ts";
import type { Features } from "./dispatch.ts";
import { noteMainTurn } from "./feedback.ts";
import type { Host } from "./host.ts";

const LEDGER = ".omca/evidence/verification-evidence.json";

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function unloggedSince(host: Host, startMs: number): Promise<string | null> {
  const [root, sessionId] = await Promise.all([host.session.root(), host.session.id()]);
  if (!isSafeSessionId(sessionId)) return null;
  const statusPath = `${root}/.omca/state/session/${sessionId}.json`;
  if (!(await host.fs.exists(statusPath))) return null;
  const slot = verificationOf(JSON.parse(await host.fs.read(statusPath)));
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
      noteMainTurn(e.turnId);
      const [{ value: sample }, usage, now, ascii] = await Promise.all([
        host.state.costSample.get(),
        host.session.usage(),
        host.clock.now(),
        host.env.OMCA_ASCII(),
      ]);
      const isSampled = sample?.turnId === e.turnId;
      const before = isSampled ? sample.usd : null;
      const after = usage.cost?.usd;
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
          costUsd: before === null || after === undefined ? null : after - before,
          unlogged,
        },
        glyphs(isAsciiRequested(ascii)),
      );
      return { ...result, text };
    },
  },
};
