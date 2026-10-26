import type { RenderElement, RenderInput } from "claude-code";
import { ledgerCoversSlot } from "../src/core/evidence.ts";
import { footerLine } from "../src/core/footer.ts";
import { statusPath, verificationOf } from "../src/core/omca-paths.ts";
import { turnFacts, type TurnRecord, turnLine } from "../src/core/turn-line.ts";
import { glyphs, type Glyphs } from "../src/core/ui-kit.ts";
import type { Piece } from "../src/core/visual.ts";
import type { Features } from "./dispatch.ts";
import { type Host, ledgerWrittenAt, reason, resolvedSession, sessionOf, update } from "./host.ts";
import { type Kit, kitOf, Line } from "./ui.ts";

type Receipt = NonNullable<TurnRecord["receipt"]>;

const KEPT_TURNS = 20;
const KEPT_LINES = 200;
// The engine draws the line's mark in a column this wide.
const MARK_CELLS = 2;

// A line belongs to the main turn that started last before the line was first drawn, so a turn
// that ends before the previous turn's facts land still gets its own. The starts are the main
// turns' since the mod loaded; a line first drawn before any of them, as after /resume, keeps the
// engine's drawing.
const starts: { turnId: string; at: number }[] = [];
const firstSeen = new Map<string, number>();
const bound = new Map<string, string>();

function kept<K, V>(map: Map<K, V>, most: number): void {
  for (const oldest of map.keys()) {
    if (map.size <= most) break;
    map.delete(oldest);
  }
}

// The status file times a run in whole seconds, so a turn that starts in the second a run ended
// would see it again; a run already on an earlier turn's line belongs to that turn.
async function receiptSince(host: Host, startMs: number, earlier: readonly TurnRecord[]): Promise<Receipt | null> {
  const [root, sessionId] = await Promise.all([host.session.root(), host.session.id()]);
  const statusFile = statusPath(root, sessionId);
  if (statusFile === undefined || !(await host.fs.exists(statusFile))) return null;
  const slot = verificationOf(JSON.parse(await host.fs.read(statusFile)));
  if (slot === null || slot.at < Math.floor(startMs / 1000)) return null;
  if (earlier.some(({ receipt }) => receipt?.at === slot.at && receipt.command === slot.command)) return null;
  return { command: slot.command, at: slot.at, isLogged: ledgerCoversSlot(await ledgerWrittenAt(host, root), slot.at) };
}

function turnIdOf(requestId: string, now: number): string | undefined {
  const known = bound.get(requestId);
  if (known !== undefined) return known;
  const seenAt = firstSeen.get(requestId) ?? now;
  firstSeen.set(requestId, seenAt);
  kept(firstSeen, KEPT_LINES);
  const start = starts.findLast((turn) => turn.at <= seenAt);
  if (start === undefined || [...bound.values()].includes(start.turnId)) return undefined;
  bound.set(requestId, start.turnId);
  kept(bound, KEPT_LINES);
  return start.turnId;
}

const clockOf = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function lineRow(kit: Kit, pieces: readonly Piece[], g: Glyphs): RenderElement {
  const { Box, Text } = kit;
  return Box({
    key: "omca-turn",
    flexDirection: "row",
    marginTop: 1,
    width: "100%",
    children: [Box({ minWidth: MARK_CELLS, children: [Text({ dimColor: true, children: [g.tier === "ascii" ? "*" : "✻"] })] }), Line(kit, pieces)],
  });
}

async function turnOf(host: Host, e: RenderInput<"TurnDuration">) {
  if (e.surface !== "terminal") return undefined;
  const [{ value: turns = [] }, now] = await Promise.all([host.state.turns.get(), host.clock.now()]);
  const turnId = turnIdOf(e.requestId, now);
  const record = turnId === undefined ? undefined : turns.find((turn) => turn.turnId === turnId);
  if (record === undefined) return undefined;
  const { isExpanded, waitingFor } = e.props;
  // The engine's own words stay where OMCA's line would drop something: the expanded view, a
  // workflow, or agents the engine waits on without naming them.
  const keepsEngine = isExpanded === true || (waitingFor === undefined ? record.waiting.length > 0 : waitingFor.workflows > 0);
  return { record, keepsEngine, waiting: waitingFor?.agents.map((agent) => agent.agentType) ?? [] };
}

export const footer: Features = {
  "turn.start": {
    async pre(host, e) {
      if (e.agentId !== undefined) return undefined;
      const [usage, at] = await Promise.all([host.session.usage(), host.clock.now()]);
      starts.push({ turnId: e.turnId, at });
      starts.splice(0, starts.length - KEPT_TURNS);
      await host.state.costSample.set({ turnId: e.turnId, usd: usage.cost?.usd ?? null, at });
      return undefined;
    },
  },
  "turn.complete": {
    async post(host, e, result) {
      if (e.agentId !== undefined) return undefined;
      const [{ value: sample }, usage, now, { glyphTier }, surfaces, { value: agents = {} }, { value: earlier = [] }] = await Promise.all([
        host.state.costSample.get(),
        host.session.usage(),
        host.clock.now(),
        sessionOf(host),
        host.session.surfaces(),
        host.state.agents.get(),
        host.state.turns.get(),
      ]);
      const isSampled = sample?.turnId === e.turnId;
      const startedAt = isSampled ? sample.at : now - e.durationMs;
      const before = isSampled ? sample.usd : null;
      const after = usage.cost?.usd;
      // A five-hour or seven-day window means a subscription, where the engine's dollar figure is not what the account pays.
      const isSubscription = usage.rateLimits.some(({ kind }) => kind === "five_hour" || kind === "seven_day");
      let receipt: Receipt | null = null;
      try {
        receipt = await receiptSince(host, startedAt, earlier);
      } catch (error) {
        host.log(`footer: cannot check this turn's verification: ${reason(error)}`);
      }
      const record: TurnRecord = {
        turnId: e.turnId,
        startedAt,
        endedAt: now,
        tokens:
          e.usage === undefined
            ? null
            : {
                input: e.usage.input_tokens + e.usage.cache_read_input_tokens + e.usage.cache_creation_input_tokens,
                output: e.usage.output_tokens,
              },
        costUsd: isSubscription || before === null || after === undefined ? null : after - before,
        receipt,
        waiting: Object.values(agents).flatMap((agent) => (agent.status === "running" && !agent.teammate && agent.endedAt === null ? [agent.type] : [])),
      };
      await update(host.state.turns, (turns) => [...(turns ?? []), record].slice(-KEPT_TURNS));
      // The terminal closes the turn with its own line, which OMCA draws; anywhere else the footer is a text row beneath the answer.
      if (surfaces.includes("terminal")) return undefined;
      const text = footerLine(
        { durationMs: e.durationMs, tokens: record.tokens, costUsd: record.costUsd, unlogged: receipt === null || receipt.isLogged ? null : receipt.command },
        glyphs(glyphTier),
      );
      return { ...result, text };
    },
  },
  "ui.render TurnDuration": {
    async pre(host, e) {
      const turn = await turnOf(host, e);
      if (turn === undefined || turn.keepsEngine) return undefined;
      const g = glyphs(resolvedSession().glyphTier);
      const { waiting } = turn;
      const { word, durationMs } = e.props;
      const doneAt = waiting.length > 0 ? null : clockOf(turn.record.endedAt);
      const pieces = turnLine({ word, durationMs, doneAt, waiting, record: turn.record }, g, (e.viewport?.columns ?? 80) - MARK_CELLS);
      return { answer: lineRow(kitOf(host.ui.resolve(e), e.surface), pieces, g) };
    },
    async post(host, e, result) {
      const turn = await turnOf(host, e);
      if (turn === undefined || !turn.keepsEngine) return undefined;
      const facts = turnFacts(turn.record, glyphs(resolvedSession().glyphTier), (e.viewport?.columns ?? 80) - MARK_CELLS);
      if (facts.length === 0) return undefined;
      const kit = kitOf(host.ui.resolve(e), e.surface);
      const { Box } = kit;
      const tail = Box({ key: "omca-turn-facts", flexDirection: "row", paddingLeft: MARK_CELLS, children: [Line(kit, facts)] });
      return Box({ key: "omca-turn", flexDirection: "column", children: [result, tail] });
    },
  },
};
