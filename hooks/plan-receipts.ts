import { allTasksDone } from "../src/core/checkboxes.ts";
import { isHookDisabled } from "../src/core/kill-switch.ts";
import { hasPassingFinalVerification } from "../src/core/next-actions.ts";
import { LEDGER } from "../src/core/omca-paths.ts";
import { boardOf, type Card, parsePlan } from "../src/core/plan-reader.ts";
import { proofSummary, shownProof } from "../src/core/proof.ts";
import { isReceiptId, type PlanComplete, type Receipt, receiptId, receiptRows, settled, type TaskReceipt, taskReceipt } from "../src/core/plan-receipts.ts";
import { sha256Hex } from "../src/core/sha256.ts";
import { glyphs } from "../src/core/ui-kit.ts";
import type { Features } from "./dispatch.ts";
import { boundPlanOf, bytesOf, type Host, ledgerDocument, proofFacts, reason, resolvedSession, update, verdictFor } from "./host.ts";
import { isRemote, kitOf, Line } from "./ui.ts";

// The engine draws the turn line's mark in a column this wide, and a receipt's rows start under the line's words.
const MARK_CELLS = 2;
const TOAST_MS = 6000;
// A remote surface reports no viewport and clips a row itself, so its rows are not cut to fit.
const UNCUT_COLUMNS = 10_000;

// The tasks already done when this plan was first read, then at each main turn since: only what
// finishes after that gets a row, so a new session or a newly bound plan places none for past work.
let seen: { path: string; done: ReadonlySet<number> } | undefined;
let placed = 0;

type Reading = { name: string; path: string; cards: readonly Card[]; tasks: ReadonlyMap<number, TaskReceipt>; complete: PlanComplete | null };

async function isOff(host: Host): Promise<boolean> {
  return isHookDisabled(await host.env.OMCA_DISABLED_HOOKS(), "plan-receipts");
}

const doneOf = (cards: readonly Card[]): ReadonlySet<number> => new Set(cards.filter((card) => card.done).map((card) => card.n));

async function readPlan(host: Host): Promise<{ name: string; path: string; bytes: Uint8Array; cards: readonly Card[] } | undefined> {
  const bound = await boundPlanOf(host);
  if (bound === undefined) return undefined;
  const bytes = await bytesOf(host, bound.path);
  return { ...bound, bytes, cards: boardOf(parsePlan(new TextDecoder().decode(bytes))).cards };
}

async function readingOf(host: Host, within: object): Promise<Reading | undefined> {
  const plan = await readPlan(host);
  if (plan === undefined) return undefined;
  const { name, path, bytes, cards } = plan;
  const facts = await proofFacts(host, cards.flatMap((card) => card.files), path, within);
  const verdicts = cards.map((card) => verdictFor(facts, card.files));
  const tasks = new Map(cards.map((card, index) => [card.n, taskReceipt(card, verdicts[index])]));
  const isComplete = allTasksDone({ done: doneOf(cards).size, total: cards.length });
  if (!isComplete) return { name, path, cards, tasks, complete: null };
  const counts = proofSummary(cards.map((card, index) => shownProof(card.done, verdicts[index]?.proof)));
  const ledger = await ledgerDocument(host, `${await host.session.root()}/${LEDGER}`);
  return { name, path, cards, tasks, complete: { ...counts, isVerified: hasPassingFinalVerification(ledger, sha256Hex(bytes)) } };
}

function nextReceipts(receipts: readonly Receipt[], reading: Reading, added: Receipt | undefined): readonly Receipt[] {
  const current = receipts.map((receipt) => (receipt.path === reading.path ? settled(receipt, reading.tasks, reading.complete) : receipt));
  return added === undefined ? current : [...current, added];
}

// A rejection is a client with no placed rows, and no `requestId` means the row does not stand at
// all: a plugin holds at most 500 in a conversation (probed on 2.1.316). A row with a `requestId`
// stands and draws when a surface attaches, so it needs no toast. A row that does not stand keeps no
// facts, so the atom holds only rows that stand and the engine's cap is the atom's.
async function place(host: Host, receipt: Receipt): Promise<void> {
  let stands = false;
  try {
    const result = await host.ui.place({ id: receipt.id });
    stands = result.isPlaced || result.requestId !== undefined;
  } catch (error) {
    host.log(`plan-receipts: placing a row failed: ${reason(error)}`);
  }
  if (stands) return;
  if (receipt.complete !== null) host.ui.toast(`Plan complete: ${receipt.plan} ${receipt.total}/${receipt.total}`, { timeoutMs: TOAST_MS });
  await update(host.state.receipts, (value) => value?.filter(({ id }) => id !== receipt.id));
}

export const planReceipts: Features = {
  "session.start": {
    post: async (host) => {
      if (await isOff(host)) return undefined;
      const plan = await readPlan(host);
      seen = plan === undefined ? undefined : { path: plan.path, done: doneOf(plan.cards) };
      return undefined;
    },
  },
  "turn.complete": {
    post: async (host, e) => {
      // A subagent's turn ends among the main turn's tool rows, so only a main turn's line carries a row.
      if (e.agentId !== undefined || (await isOff(host))) return undefined;
      const reading = await readingOf(host, e);
      if (reading === undefined) return undefined;
      const done = doneOf(reading.cards);
      const before = seen?.path === reading.path ? seen.done : done;
      seen = { path: reading.path, done };
      const finished = reading.cards.filter((card) => card.done && !before.has(card.n));
      const at = await host.clock.now();
      const added: Receipt | undefined =
        finished.length === 0
          ? undefined
          : {
              id: receiptId(at, (placed += 1)),
              plan: reading.name,
              path: reading.path,
              total: reading.cards.length,
              tasks: finished.flatMap((card) => reading.tasks.get(card.n) ?? []),
              complete: reading.complete,
            };
      await update(host.state.receipts, (value) => {
        const stored = value ?? [];
        const next = nextReceipts(stored, reading, added);
        return JSON.stringify(next) === JSON.stringify(stored) ? value : next;
      });
      if (added !== undefined) await place(host, added);
      return undefined;
    },
  },
  "ui.render Placed": {
    async pre(host, e) {
      if (!isReceiptId(e.props.id)) return undefined;
      const { value = [] } = await host.state.receipts.get();
      const receipt = value.find(({ id }) => id === e.props.id);
      if (receipt === undefined) return undefined;
      const g = glyphs(resolvedSession().glyphTier);
      const kit = kitOf(host.ui.resolve(e), e.surface);
      const { Box } = kit;
      const indent = isRemote(kit) ? 0 : MARK_CELLS;
      const columns = isRemote(kit) ? UNCUT_COLUMNS : (e.viewport?.columns ?? 80) - indent;
      const rows = receiptRows(receipt, g, columns);
      return { answer: Box({ key: "omca-receipt", flexDirection: "column", paddingLeft: indent, children: rows.map((pieces) => Line(kit, pieces)) }) };
    },
  },
};
