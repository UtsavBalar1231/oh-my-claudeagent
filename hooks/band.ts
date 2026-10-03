import type { RenderElement } from "claude-code";
import { type Band, bandView, BUTTON_GAP, oneLine, type Span, type Tone } from "../src/core/band-model.ts";
import { resolveBoundPlan } from "../src/core/boulder.ts";
import { allTasksDone, checkboxStates } from "../src/core/checkboxes.ts";
import { ledgerCoversSlot } from "../src/core/evidence.ts";
import { hasPassingFinalVerification, type NextAction, nextActions } from "../src/core/next-actions.ts";
import { BOULDER, LEDGER, statusPath, verificationOf } from "../src/core/omca-paths.ts";
import { glyphs, isAsciiRequested } from "../src/core/ui-kit.ts";
import { TONE_KEYS } from "../src/core/visual.ts";
import type { Features } from "./dispatch.ts";
import { type Host, reason } from "./host.ts";
import { type Kit, kitOf, type TextStyle } from "./ui.ts";

type Snapshot = { band: Band; hasFinalVerification: boolean };

let isAscii = false;
let shownActions = 0;

// A bare digit in an empty composer reaches prompt.edit before the engine resolves it as the
// band Button's hotkey, so clearing on that edit would take the Button away from its own press.
const isShownHotkey = (text: string): boolean => {
  const key = text.trim();
  return /^[1-9]$/.test(key) && Number(key) <= shownActions;
};

async function readJson(host: Host, path: string): Promise<unknown> {
  return (await host.fs.exists(path)) ? JSON.parse(await host.fs.read(path)) : undefined;
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

  const bound = await attempt(BOULDER, async () => {
    const plan = resolveBoundPlan(await readJson(host, `${root}/${BOULDER}`), sessionId, true);
    return "plan_name" in plan ? plan : null;
  });
  const planText = bound === null ? null : await attempt(bound.active_plan, () => host.fs.read(bound.active_plan));
  const plan =
    bound === null || planText === null
      ? null
      : { name: bound.plan_name, path: bound.active_plan, ...countTasks(planText) };

  const statusFile = statusPath(root, sessionId);
  const verification =
    statusFile === undefined
      ? null
      : await attempt(`the session status file`, async () => {
          const slot = verificationOf(await readJson(host, statusFile));
          if (slot === null) return null;
          const ledgerMtimeSeconds = (await host.fs.exists(ledgerPath))
            ? Math.floor((await host.fs.stat(ledgerPath)).mtimeMs / 1000)
            : 0;
          return { ...slot, isLogged: ledgerCoversSlot(ledgerMtimeSeconds, slot.at) };
        });

  const hasFinalVerification =
    plan !== null &&
    planText !== null &&
    allTasksDone(plan) &&
    (await attempt(LEDGER, async () =>
      hasPassingFinalVerification(await readJson(host, ledgerPath), await sha256(planText)),
    )) === true;

  return { band: { plan, verification, error: errors[0] ?? null, readAt }, hasFinalVerification };
}

function countTasks(text: string): { done: number; total: number } {
  const states = checkboxStates(text);
  return { done: states.filter((state) => state === "x").length, total: states.length };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  muted: { dimColor: true },
  ok: { color: TONE_KEYS.ok },
  warn: { color: TONE_KEYS.warn },
  fail: { color: TONE_KEYS.fail },
};

const row = ({ Text }: Kit, spans: readonly Span[]): RenderElement =>
  Text({ wrap: "truncate-end", children: spans.map((span) => Text({ ...TONES[span.tone], children: [span.text] })) });

export const band: Features = {
  "session.start": {
    post: async (host) => {
      isAscii = isAsciiRequested(await host.env.OMCA_ASCII());
      shownActions = ((await host.state.nextActions.get()).value ?? []).length;
      await writeBand(host, (await readSnapshot(host)).band);
      return undefined;
    },
  },
  "turn.complete": {
    post: async (host, e) => {
      const snapshot = await readSnapshot(host);
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
      const [{ value: snapshot }, { value: actions = [] }] = await Promise.all([
        host.state.band.get(),
        host.state.nextActions.get(),
      ]);
      const view = bandView(snapshot, actions, e.props.bodyColumns, glyphs(isAscii));
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
