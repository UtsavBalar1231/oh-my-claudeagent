import type { RenderElement } from "claude-code";
import { type Band, bandView, BUTTON_GAP, type Span, type Tone } from "../src/core/band-model.ts";
import { ledgerCoversSlot } from "../src/core/evidence.ts";
import { type NextAction, nextActions } from "../src/core/next-actions.ts";
import { exitCodeOf, LEDGER, statusPath, verificationOf } from "../src/core/omca-paths.ts";
import { type RunSummary, runSummary } from "../src/core/run-line.ts";
import { fitEnd, type GlyphTier, glyphs, oneLine } from "../src/core/ui-kit.ts";
import { TONE_KEYS } from "../src/core/visual.ts";
import type { Features } from "./dispatch.ts";
import { fillPrompt, type Host, ledgerWrittenAt, reason, sessionOf, stampOf } from "./host.ts";
import { isRemote, type Kit, kitOf, Line, Run, type TextStyle } from "./ui.ts";

type Snapshot = { band: Band; exitCode: number | null };

let glyphTier: GlyphTier = "nerd";
let shownActions = 0;
let isAgentInView = false;
let toastedVerificationAt = 0;
let isBaselined = false;
let readStamps: string | undefined;

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

async function readSnapshot(host: Host): Promise<Snapshot> {
  const [root, sessionId, readAt] = await Promise.all([host.session.root(), host.session.id(), host.clock.now()]);
  const statusFile = statusPath(root, sessionId);
  let exitCode: number | null = null;
  let error: string | null = null;
  let verification: Band["verification"] = null;
  if (statusFile !== undefined) {
    try {
      const status = await readJson(host, statusFile);
      exitCode = exitCodeOf(status);
      const slot = verificationOf(status);
      if (slot !== null) verification = { ...slot, isLogged: ledgerCoversSlot(await ledgerWrittenAt(host, root), slot.at) };
    } catch (failure) {
      error = `Cannot read the session status file: ${oneLine(reason(failure))}`;
    }
  }
  return { band: { verification, error, readAt }, exitCode };
}

// What a snapshot is read from, so a subagent's turn that moved neither reads nothing.
async function stampsOf(host: Host): Promise<string> {
  const [root, sessionId] = await Promise.all([host.session.root(), host.session.id()]);
  const status = statusPath(root, sessionId);
  const paths = [`${root}/${LEDGER}`, status ?? ""];
  return JSON.stringify(await Promise.all(paths.map((path) => (path === "" ? "none" : stampOf(host, path)))));
}

async function snapshotOf(host: Host): Promise<Snapshot> {
  const stamps = await stampsOf(host);
  const snapshot = await readSnapshot(host);
  readStamps = stamps;
  return snapshot;
}

// The first read after session.start only records what already happened; later reads toast what changed.
function toastChanges(host: Host, { band, exitCode }: Snapshot): void {
  const isBaseline = !isBaselined;
  isBaselined = true;
  const { verification } = band;
  const verifiedAt = verification?.at ?? 0;
  if (!isBaseline && verification !== null && verifiedAt > toastedVerificationAt && exitCode !== null && exitCode !== 0) {
    const { ellipsis } = glyphs(glyphTier);
    host.ui.toast(`Verification failed: ${fitEnd(oneLine(verification.command), COMMAND_CELLS, ellipsis)} (exit ${exitCode})`, {
      timeoutMs: TOAST_MS,
    });
  }
  toastedVerificationAt = Math.max(toastedVerificationAt, verifiedAt);
}

async function clearActionsFor(host: Host, text: string): Promise<void> {
  if (isAgentInView || shownActions === 0 || text === "" || isShownHotkey(text)) return;
  shownActions = 0;
  await host.state.nextActions.set([]);
}

async function openRun(host: Host): Promise<RunSummary | undefined> {
  const { value } = await host.state.tasks.get();
  const run = value === undefined ? undefined : runSummary(value.tasks);
  return run?.isOpen === true ? run : undefined;
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
  plain: {},
  muted: { color: TONE_KEYS.muted },
  ok: { color: TONE_KEYS.ok },
  warn: { color: TONE_KEYS.warn },
  fail: { color: TONE_KEYS.fail },
};

const row = (kit: Kit, spans: readonly Span[]): RenderElement =>
  Run(kit, spans.map(({ text, tone }) => ({ style: TONES[tone], text })));

export const band: Features = {
  "session.start": {
    post: async (host) => {
      glyphTier = (await sessionOf(host)).glyphTier;
      shownActions = ((await host.state.nextActions.get()).value ?? []).length;
      const snapshot = await snapshotOf(host);
      toastedVerificationAt = 0;
      isBaselined = false;
      toastChanges(host, snapshot);
      await writeBand(host, snapshot.band);
      return undefined;
    },
  },
  "turn.complete": {
    post: async (host, e) => {
      if (e.agentId !== undefined && (await stampsOf(host)) === readStamps) return undefined;
      const snapshot = await snapshotOf(host);
      toastChanges(host, snapshot);
      await writeBand(host, snapshot.band);
      if (e.agentId === undefined) await writeActions(host, nextActions({ verification: snapshot.band.verification, isRunOpen: (await openRun(host)) !== undefined }));
      return undefined;
    },
  },
  "prompt.edit": {
    post: async (host, _e, result) => {
      await clearActionsFor(host, result.text);
      return undefined;
    },
  },
  "prompt.change": {
    post: async (host, e, result) => {
      const isOwnFill = e.origin.kind === "plugin" && e.origin.name === host.plugin.name;
      if (!isOwnFill) await clearActionsFor(host, result.text);
      return undefined;
    },
  },
  "ui.render AbovePrompt": {
    post: async (host, e, beneath) => {
      isAgentInView = e.props.view.agentId !== undefined;
      if (!host.options.showBand || e.props.hasSurvey) return undefined;
      const [{ value: snapshot }, { value: actions = [] }, run] = await Promise.all([host.state.band.get(), host.state.nextActions.get(), openRun(host)]);
      const view = bandView(snapshot, isAgentInView ? [] : actions, e.props.bodyColumns, glyphTier, run);
      if (view === undefined) return undefined;
      const kit = kitOf(host.ui.resolve(e), e.surface);
      const { Box, Button } = kit;
      const rows = [
        ...(view.status.length === 0 ? [] : [Box({ key: "status", children: [row(kit, view.status)] })]),
        ...(view.run.length === 0 ? [] : [Box({ key: "run", children: [Line(kit, view.run)] })]),
      ];
      if (view.buttons.length > 0) {
        rows.push(
          Box({
            key: "actions",
            gap: isRemote(kit) ? "lg" : BUTTON_GAP,
            children: view.buttons.map((button) =>
              Button({
                key: button.key,
                label: button.label,
                hotkey: button.hotkey,
                plain: true,
                onPress: async () => {
                  try {
                    await fillPrompt(host, button.prompt);
                  } catch (error) {
                    host.log(`band: filling the prompt failed: ${reason(error)}`);
                  }
                },
              }),
            ),
          }),
        );
      }
      // The engine refuses the whole band when the Box holding `beneath`, or any Box around it,
      // sets a size, a position, `display` or `overflow`.
      return Box({ key: "omca-band", flexDirection: "column", children: [...rows, beneath] });
    },
  },
};
