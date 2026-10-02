import type { ElementTable, RenderElement, TextProps, Timer } from "claude-code";
import { type Band, bandView, BUTTON_GAP, oneLine, type Span, type Tone } from "../src/core/band-model.ts";
import { resolveBoundPlan } from "../src/core/boulder.ts";
import { checkboxStates } from "../src/core/checkboxes.ts";
import { ledgerCoversSlot } from "../src/core/evidence.ts";
import { hasPassingFinalVerification, isPlanComplete, type NextAction, nextActions } from "../src/core/next-actions.ts";
import { isSafeSessionId } from "../src/core/session-id.ts";
import { COLORS, glyphs, isAsciiRequested } from "../src/core/ui-kit.ts";
import type { Features } from "./dispatch.ts";
import type { Host } from "./host.ts";

const BOULDER = ".omca/state/boulder.json";
const LEDGER = ".omca/evidence/verification-evidence.json";
// Long enough to fold the events of one turn's end (the turn, its agents, the edits that follow)
// into one trailing redraw, short enough that the band never visibly lags.
const QUIET_MS = 100;

type Snapshot = { band: Band; planText: string | null; ledgerPath: string };

let isAscii = false;
let shownActions = 0;
let quiet: Timer | undefined;
let isRedrawPending = false;

function invalidate(host: Host): void {
  if (quiet !== undefined) {
    isRedrawPending = true;
    return;
  }
  host.ui.invalidate();
  quiet = host.clock.after(QUIET_MS, () => {
    quiet = undefined;
    if (!isRedrawPending) return;
    isRedrawPending = false;
    invalidate(host);
  });
}

// A bare digit in an empty composer reaches prompt.edit before the engine resolves it as the
// band Button's hotkey, so clearing on that edit would take the Button away from its own press.
const isShownHotkey = (text: string): boolean => {
  const key = text.trim();
  return /^[1-9]$/.test(key) && Number(key) <= shownActions;
};

const reason = (error: unknown): string => oneLine(error instanceof Error ? error.message : String(error));

async function readJson(host: Host, path: string): Promise<unknown> {
  return (await host.fs.exists(path)) ? JSON.parse(await host.fs.read(path)) : undefined;
}

export function verificationOf(status: unknown): { command: string; at: number } | null {
  if (typeof status !== "object" || status === null || !("verification" in status)) return null;
  const { verification } = status;
  if (typeof verification !== "object" || verification === null) return null;
  if (!("command" in verification) || !("at" in verification)) return null;
  const { command, at } = verification;
  return typeof command === "string" && typeof at === "number" ? { command, at } : null;
}

async function readSnapshot(host: Host): Promise<Snapshot> {
  const [root, sessionId, readAt] = await Promise.all([host.session.root(), host.session.id(), host.clock.now()]);
  const ledgerPath = `${root}/${LEDGER}`;
  const errors: string[] = [];
  async function attempt<T>(what: string, read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (error) {
      errors.push(`Cannot read ${what}: ${reason(error)}`);
      return null;
    }
  }

  const bound = await attempt(BOULDER, async () => {
    const plan = resolveBoundPlan(await readJson(host, `${root}/${BOULDER}`), sessionId, true);
    return "plan_name" in plan ? plan : null;
  });
  const planText = bound === null ? null : await attempt(bound.active_plan, () => host.fs.read(bound.active_plan));
  const plan =
    bound === null || planText === null
      ? null
      : { name: bound.plan_name, path: bound.active_plan, ...countTasks(planText) };

  const verification = isSafeSessionId(sessionId)
    ? await attempt(`the session status file`, async () => {
        const slot = verificationOf(await readJson(host, `${root}/.omca/state/session/${sessionId}.json`));
        if (slot === null) return null;
        const ledgerMtimeSeconds = (await host.fs.exists(ledgerPath))
          ? Math.floor((await host.fs.stat(ledgerPath)).mtimeMs / 1000)
          : 0;
        return { ...slot, isLogged: ledgerCoversSlot(ledgerMtimeSeconds, slot.at) };
      })
    : null;

  return { band: { plan, verification, error: errors[0] ?? null, readAt }, planText, ledgerPath };
}

function countTasks(text: string): { done: number; total: number } {
  const states = checkboxStates(text);
  return { done: states.filter((state) => state === "x").length, total: states.length };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function actionsFor(host: Host, { band, planText, ledgerPath }: Snapshot): Promise<NextAction[]> {
  const agents = (await host.state.agents.get()).value ?? {};
  const isComplete = band.plan !== null && isPlanComplete(band.plan);
  return nextActions({
    plan: band.plan,
    verification: band.verification,
    isAgentRunning: Object.values(agents).some((agent) => agent.status === "running"),
    hasFinalVerification:
      isComplete &&
      planText !== null &&
      hasPassingFinalVerification(await readJson(host, ledgerPath), await sha256(planText)),
  });
}

const withoutReadAt = (band: Band | undefined): string => JSON.stringify({ ...band, readAt: 0 });

async function writeBand(host: Host, band: Band): Promise<boolean> {
  const { value } = await host.state.band.get();
  if (withoutReadAt(value) === withoutReadAt(band)) return false;
  await host.state.band.set(band);
  return true;
}

async function writeActions(host: Host, actions: readonly NextAction[]): Promise<boolean> {
  const { value = [] } = await host.state.nextActions.get();
  shownActions = actions.length;
  if (JSON.stringify(value) === JSON.stringify(actions)) return false;
  await host.state.nextActions.set(actions);
  return true;
}

const TONES: Record<Tone, TextProps> = {
  title: { bold: true },
  plain: {},
  muted: { dimColor: true },
  ok: { color: COLORS.ok },
  warn: { color: COLORS.warn },
  fail: { color: COLORS.fail },
};

const row = ({ Text }: ElementTable, spans: readonly Span[]): RenderElement =>
  Text({ wrap: "truncate-end", children: spans.map((span) => Text({ ...TONES[span.tone], children: [span.text] })) });

export const band: Features = {
  "session.start": {
    post: async (host) => {
      isAscii = isAsciiRequested(await host.env.OMCA_ASCII());
      shownActions = ((await host.state.nextActions.get()).value ?? []).length;
      if (await writeBand(host, (await readSnapshot(host)).band)) invalidate(host);
      return undefined;
    },
  },
  "turn.complete": {
    post: async (host, e) => {
      const snapshot = await readSnapshot(host);
      const isBandChanged = await writeBand(host, snapshot.band);
      const isActionsChanged = e.agentId === undefined && (await writeActions(host, await actionsFor(host, snapshot)));
      if (isBandChanged || isActionsChanged) invalidate(host);
      return undefined;
    },
  },
  "prompt.edit": {
    post: async (host, _e, result) => {
      if (shownActions === 0 || result.text === "" || isShownHotkey(result.text)) return undefined;
      shownActions = 0;
      await host.state.nextActions.set([]);
      invalidate(host);
      return undefined;
    },
  },
  "ui.render AbovePrompt": {
    pre: async (host, e) => {
      if (!host.options.showBand || e.props.hasSurvey) return undefined;
      const [{ value: snapshot }, { value: actions = [] }] = await Promise.all([
        host.state.band.get(),
        host.state.nextActions.get(),
      ]);
      const view = bandView(snapshot, actions, e.props.bodyColumns, glyphs(isAscii));
      if (view === undefined) return undefined;
      const kit = host.ui.resolve(e);
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
