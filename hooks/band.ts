import type { RenderElement } from "claude-code";
import { type Band, bandView, BUTTON_GAP, planTally, type Proof, type Span, type Tone } from "../src/core/band-model.ts";
import { allTasksDone } from "../src/core/checkboxes.ts";
import { ledgerCoversSlot, readLedger } from "../src/core/evidence.ts";
import { hasPassingFinalVerification, type NextAction, nextActions } from "../src/core/next-actions.ts";
import { BOULDER, exitCodeOf, LEDGER, statusPath, verificationOf } from "../src/core/omca-paths.ts";
import { boardOf, parsePlan } from "../src/core/plan-reader.ts";
import { proofSummary } from "../src/core/proof.ts";
import { sha256Hex } from "../src/core/sha256.ts";
import { fitEnd, type GlyphTier, glyphs, oneLine } from "../src/core/ui-kit.ts";
import { TONE_KEYS } from "../src/core/visual.ts";
import type { Features } from "./dispatch.ts";
import { boundPlanOf, bytesOf, type Host, ledgerWrittenAt, proofFacts, reason, sessionOf, verdictFor } from "./host.ts";
import { type Kit, kitOf, type TextStyle } from "./ui.ts";

type Snapshot = { band: Band; hasFinalVerification: boolean; exitCode: number | null };

let glyphTier: GlyphTier = "nerd";
let shownActions = 0;
let toastedVerificationAt = 0;
let toastedPlan: { path: string; isDone: boolean } | undefined;
let isBaselined = false;

const TOAST_MS = 6000;
const COMMAND_CELLS = 30;

// A bare digit in an empty composer reaches prompt.edit before the engine resolves it as the
// band Button's hotkey, so clearing on that edit would take the Button away from its own press.
const isShownHotkey = (text: string): boolean => {
  const key = text.trim();
  return /^[1-9]$/.test(key) && Number(key) <= shownActions;
};

async function readJson(host: Host, path: string): Promise<unknown> {
  return (await host.fs.exists(path)) ? JSON.parse(await host.fs.read(path)) : undefined;
}

async function ledgerDocument(host: Host, path: string): Promise<unknown> {
  if (!(await host.fs.exists(path))) return undefined;
  const read = readLedger(await host.fs.read(path));
  if (read.kind === "refused") throw new Error(read.reason);
  return read.document;
}

async function readSnapshot(host: Host): Promise<Snapshot> {
  const [root, sessionId, readAt] = await Promise.all([host.session.root(), host.session.id(), host.clock.now()]);
  const ledgerPath = `${root}/${LEDGER}`;
  const errors: string[] = [];
  async function attempt<T>(what: string, read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (error) {
      errors.push(`Cannot read ${what}: ${oneLine(reason(error))}`);
      return null;
    }
  }

  const bound = await attempt(BOULDER, async () => (await boundPlanOf(host)) ?? null);
  const planBytes = bound === null ? null : await attempt(bound.path, () => bytesOf(host, bound.path));
  const planText = planBytes === null ? null : new TextDecoder().decode(planBytes);
  const plan = bound === null || planText === null ? null : { ...bound, ...planTally(planText) };

  const statusFile = statusPath(root, sessionId);
  let exitCode: number | null = null;
  const verification =
    statusFile === undefined
      ? null
      : await attempt(`the session status file`, async () => {
          const status = await readJson(host, statusFile);
          exitCode = exitCodeOf(status);
          const slot = verificationOf(status);
          if (slot === null) return null;
          return { ...slot, isLogged: ledgerCoversSlot(await ledgerWrittenAt(host, root), slot.at) };
        });

  const hasFinalVerification =
    plan !== null &&
    planBytes !== null &&
    allTasksDone(plan) &&
    (await attempt(LEDGER, async () =>
      hasPassingFinalVerification(await ledgerDocument(host, ledgerPath), sha256Hex(planBytes)),
    )) === true;

  const proof = planText === null ? null : await attempt(LEDGER, () => proofOfPlan(host, planText));
  const band: Band = { plan, verification, ...(proof === null ? {} : { proof }), error: errors[0] ?? null, readAt };
  return { band, hasFinalVerification, exitCode };
}

// The plan board's counts: each task's verdict is the newest test, build or lint run since its
// listed files last changed. Null when no task lists a file that exists.
async function proofOfPlan(host: Host, planText: string): Promise<Proof | null> {
  const { cards } = boardOf(parsePlan(planText));
  const facts = await proofFacts(host, cards.flatMap((card) => card.files));
  if (facts.ledgerError !== null) throw new Error(facts.ledgerError);
  const counts = proofSummary(cards.map((card) => verdictFor(facts, card.files)?.proof));
  return counts.proven + counts.unproven + counts.failed === 0 ? null : counts;
}

// The first read after session.start only records what already happened; later reads toast what changed.
async function toastChanges(host: Host, { band, exitCode }: Snapshot): Promise<void> {
  const isBaseline = !isBaselined;
  isBaselined = true;
  const { plan, verification } = band;
  const verifiedAt = verification?.at ?? 0;
  if (!isBaseline && verification !== null && verifiedAt > toastedVerificationAt && exitCode !== null && exitCode !== 0) {
    const { ellipsis } = glyphs(glyphTier);
    host.ui.toast(`Verification failed: ${fitEnd(oneLine(verification.command), COMMAND_CELLS, ellipsis)} (exit ${exitCode})`, {
      timeoutMs: TOAST_MS,
    });
  }
  toastedVerificationAt = Math.max(toastedVerificationAt, verifiedAt);
  const isDone = plan !== null && plan.total > 0 && plan.done === plan.total;
  if (!isBaseline && plan !== null && isDone && toastedPlan?.path === plan.path && !toastedPlan.isDone) {
    host.ui.toast(`Plan complete: ${plan.name} ${plan.done}/${plan.total}`, { timeoutMs: TOAST_MS });
  }
  toastedPlan = plan === null ? undefined : { path: plan.path, isDone };
}

async function actionsFor(host: Host, { band, hasFinalVerification }: Snapshot): Promise<NextAction[]> {
  const agents = (await host.state.agents.get()).value ?? {};
  return nextActions({
    plan: band.plan,
    verification: band.verification,
    isAgentRunning: Object.values(agents).some((agent) => agent.status === "running"),
    hasFinalVerification,
  });
}

const withoutReadAt = (band: Band | undefined): string => JSON.stringify({ ...band, readAt: 0 });

async function writeBand(host: Host, band: Band): Promise<void> {
  const { value } = await host.state.band.get();
  if (withoutReadAt(value) !== withoutReadAt(band)) await host.state.band.set(band);
}

async function writeActions(host: Host, actions: readonly NextAction[]): Promise<void> {
  const { value = [] } = await host.state.nextActions.get();
  shownActions = actions.length;
  if (JSON.stringify(value) !== JSON.stringify(actions)) await host.state.nextActions.set(actions);
}

const TONES: Record<Tone, TextStyle> = {
  title: { bold: true },
  plain: {},
  muted: { color: TONE_KEYS.muted },
  ok: { color: TONE_KEYS.ok },
  warn: { color: TONE_KEYS.warn },
  fail: { color: TONE_KEYS.fail },
  active: { color: TONE_KEYS.active },
};

const row = ({ Text }: Kit, spans: readonly Span[]): RenderElement =>
  Text({ wrap: "truncate-end", children: spans.map(({ text, tone, ...keys }) => Text({ ...TONES[tone], ...keys, children: [text] })) });

export const band: Features = {
  "session.start": {
    post: async (host) => {
      glyphTier = (await sessionOf(host)).glyphTier;
      shownActions = ((await host.state.nextActions.get()).value ?? []).length;
      const snapshot = await readSnapshot(host);
      toastedVerificationAt = 0;
      toastedPlan = undefined;
      isBaselined = false;
      await toastChanges(host, snapshot);
      await writeBand(host, snapshot.band);
      return undefined;
    },
  },
  "turn.complete": {
    post: async (host, e) => {
      const snapshot = await readSnapshot(host);
      await toastChanges(host, snapshot);
      await writeBand(host, snapshot.band);
      if (e.agentId === undefined) await writeActions(host, await actionsFor(host, snapshot));
      return undefined;
    },
  },
  "prompt.edit": {
    post: async (host, _e, result) => {
      if (shownActions === 0 || result.text === "" || isShownHotkey(result.text)) return undefined;
      shownActions = 0;
      await host.state.nextActions.set([]);
      return undefined;
    },
  },
  "ui.render AbovePrompt": {
    pre: async (host, e) => {
      if (!host.options.showBand || e.props.hasSurvey) return undefined;
      const [{ value: snapshot }, { value: actions = [] }, { value: agents = {} }] = await Promise.all([
        host.state.band.get(),
        host.state.nextActions.get(),
        host.state.agents.get(),
      ]);
      const running = Object.values(agents).filter((agent) => agent.status === "running").length;
      const view = bandView(snapshot, actions, e.props.bodyColumns, glyphTier, running);
      if (view === undefined) return undefined;
      const kit = kitOf(host.ui.resolve(e), e.surface);
      const { Box, Button } = kit;
      const rows = [Box({ key: "status", children: [row(kit, view.status)] })];
      if (view.buttons.length > 0) {
        rows.push(
          Box({
            key: "actions",
            gap: BUTTON_GAP,
            children: view.buttons.map((button) =>
              Button({
                key: button.key,
                label: button.label,
                hotkey: button.hotkey,
                plain: true,
                onPress: async () => {
                  try {
                    await host.prompt.fill({ text: button.prompt });
                  } catch (error) {
                    host.log(`band: filling the prompt failed: ${reason(error)}`);
                  }
                },
              }),
            ),
          }),
        );
      }
      return { answer: Box({ key: "omca-band", flexDirection: "column", children: rows }) };
    },
  },
};
