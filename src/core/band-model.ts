import { planTasks } from "./checkboxes.ts";
import type { NextAction, NextActionKind } from "./next-actions.ts";
import { arrange, displayWidth, fitEnd, type Glyphs, glyphs, type GlyphTier, oneLine, type Ranked, share, usableColumns } from "./ui-kit.ts";
import { bar, piecesWidth, type ThemeKey } from "./visual.ts";

export type NextTask = { n: number; title: string };
export type Proof = { proven: number; unproven: number; failed: number };

export type Band = {
  plan: { name: string; path: string; done: number; total: number; next: NextTask | null } | null;
  verification: { command: string; at: number; isLogged: boolean } | null;
  proof?: Proof;
  error: string | null;
  readAt: number;
};

export type Tone = "title" | "plain" | "muted" | "ok" | "warn" | "fail" | "active";
// The progress bar's cells carry their own keys, a seam cell two.
export type Span = { text: string; tone: Tone; color?: ThemeKey; backgroundColor?: ThemeKey };
export type BandButton = { key: NextActionKind; hotkey: string; label: string; prompt: string };
export type BandView = { status: readonly Span[]; buttons: readonly BandButton[] };

type Part = Span & { isFlexible?: true };
type Words = { noPlan: string; logged: string; unlogged: string; proof: Readonly<Record<keyof Proof, string>> };

const FULL: Words = {
  noPlan: "no plan bound",
  logged: " evidence logged",
  unlogged: " evidence not logged",
  proof: { proven: " proven", unproven: " unproven", failed: " failed" },
};
const COMPACT: Words = { noPlan: "no plan", logged: " logged", unlogged: " not logged", proof: { proven: "", unproven: "", failed: "" } };

// Below this many cells a flexible part (task title, command) stops reading as a name.
const MIN_FLEXIBLE = 14;
const BAR_CELLS = 5;
export const BUTTON_GAP = 3;
// The engine draws the band's collapse mark, `[-]`, over the last three columns of its first row,
// so the status row stops one column short of it.
const MARK_CELLS = 4;
// A plain Button draws its hotkey, a colon and a space before the label.
const HOTKEY_CELLS = 3;

// The order a narrowing band gives segments up in, last first: progress is the one fact that
// always stays, then whether agents run, what comes next, the proof, then the verification.
const PRIORITY = { progress: 1, running: 2, next: 3, proof: 4, unlogged: 5, logged: 6 } as const;

/** The numbered tasks' tally and the first open one, read the way every plan reader reads them. */
export function planTally(text: string): { done: number; total: number; next: NextTask | null } {
  const tasks = planTasks(text);
  const open = tasks.find((task) => !task.checked);
  return {
    done: tasks.filter((task) => task.checked).length,
    total: tasks.length,
    next: open === undefined ? null : { n: open.number, title: oneLine(open.label) },
  };
}

type Segment = Ranked & { parts: Part[] };

const segment = (priority: number, parts: Part[]): Segment => ({
  priority,
  parts,
  min: parts.reduce((sum, part) => sum + (part.isFlexible ? Math.min(MIN_FLEXIBLE, displayWidth(part.text)) : displayWidth(part.text)), 0),
});

// Only the counts that are not zero, each a glyph and a number, and a word while the band has room.
function proofParts(proof: Proof, g: Glyphs, words: Words): Part[] {
  const kinds = [
    ["proven", g.check, "ok"],
    ["unproven", g.warn, "warn"],
    ["failed", g.cross, "fail"],
  ] as const;
  return kinds
    .filter(([kind]) => proof[kind] > 0)
    .flatMap(([kind, glyph, tone], index): Part[] => [
      ...(index === 0 ? [] : [{ text: "  ", tone: "muted" as const }]),
      { text: `${glyph} `, tone },
      { text: `${proof[kind]}${words.proof[kind]}`, tone: "plain" },
    ]);
}

function statusSegments(band: Band, words: Words, g: Glyphs, ascii: boolean, running: number): Segment[] {
  if (band.error !== null) {
    return [segment(0, [{ text: `${g.cross} `, tone: "fail" }, { text: oneLine(band.error), tone: "plain", isFlexible: true }])];
  }
  const { plan, verification, proof } = band;
  const segments: Segment[] = [];
  if (plan === null) {
    segments.push(segment(PRIORITY.progress, [{ text: words.noPlan, tone: "muted" }]));
  } else {
    const cells = bar({ done: plan.done, todo: plan.total - plan.done }, BAR_CELLS, ascii).map((piece): Span => ({ ...piece, tone: "plain" }));
    segments.push(segment(PRIORITY.progress, [...cells, { text: ` ${plan.done}/${plan.total}`, tone: "muted" }]));
    if (plan.next !== null) {
      segments.push(
        segment(PRIORITY.next, [
          { text: "next ", tone: "muted" },
          { text: `${plan.next.n} `, tone: "title" },
          { text: oneLine(plan.next.title), tone: "plain", isFlexible: true },
        ]),
      );
    }
  }
  const proven = proof === undefined ? [] : proofParts(proof, g, words);
  if (proven.length > 0) segments.push(segment(PRIORITY.proof, proven));
  if (verification !== null) {
    const { isLogged } = verification;
    segments.push(
      segment(isLogged ? PRIORITY.logged : PRIORITY.unlogged, [
        { text: `${isLogged ? g.check : g.warn} `, tone: isLogged ? "ok" : "warn" },
        { text: oneLine(verification.command), tone: "plain", isFlexible: true },
        { text: isLogged ? words.logged : words.unlogged, tone: isLogged ? "muted" : "plain" },
      ]),
    );
  }
  if (running > 0) {
    segments.push(
      segment(PRIORITY.running, [
        { text: `${g.agent} `, tone: "active" },
        { text: `${running} running`, tone: "plain" },
      ]),
    );
  }
  return segments;
}

function joined(segments: readonly Segment[], g: Glyphs): Part[] {
  return segments.flatMap((kept, index) => [...(index === 0 ? [] : [{ text: ` ${g.dot} `, tone: "muted" as const }]), ...kept.parts]);
}

const fixedWidth = (parts: readonly Part[]): number =>
  parts.reduce((sum, part) => sum + (part.isFlexible ? 0 : displayWidth(part.text)), 0);

function fitParts(parts: readonly Part[], width: number, g: Glyphs): Span[] {
  const sizes = share(
    parts.filter((part) => part.isFlexible).map((part) => displayWidth(part.text)),
    width - fixedWidth(parts),
  );
  let flexible = 0;
  return parts.map(({ isFlexible, ...span }) => (isFlexible ? { ...span, text: fitEnd(span.text, sizes[flexible++] ?? 0, g.ellipsis) } : span));
}

function clip(spans: readonly Span[], width: number, g: Glyphs): Span[] {
  if (piecesWidth(spans) <= width) return spans.filter((span) => span.text !== "");
  const out: Span[] = [];
  let left = width;
  for (const span of spans) {
    const cells = displayWidth(span.text);
    if (cells >= left) {
      out.push({ ...span, text: fitEnd(`${span.text}${g.ellipsis}`, left, g.ellipsis) });
      break;
    }
    if (cells > 0) out.push(span);
    left -= cells;
  }
  return out.filter((span) => span.text !== "");
}

function statusRow(band: Band, width: number, tier: GlyphTier, running: number): Span[] {
  const g = glyphs(tier);
  const ascii = tier === "ascii";
  const gap = displayWidth(` ${g.dot} `);
  const full = statusSegments(band, FULL, g, ascii, running);
  const kept = arrange(full, width, gap);
  const chosen = kept.length === full.length ? kept : arrange(statusSegments(band, COMPACT, g, ascii, running), width, gap);
  return clip(fitParts(joined(chosen, g), width, g), width, g);
}

function buttonRow(actions: readonly NextAction[], width: number, g: Glyphs): BandButton[] {
  const room = width - actions.length * HOTKEY_CELLS - Math.max(0, actions.length - 1) * BUTTON_GAP;
  const sizes = share(
    actions.map((action) => displayWidth(action.label)),
    room,
  );
  return actions.map((action, index) => ({
    key: action.kind,
    hotkey: String(index + 1),
    label: fitEnd(action.label, sizes[index] ?? 0, g.ellipsis),
    prompt: action.prompt,
  }));
}

/** Nothing to draw (undefined) until the first snapshot, and while neither section has content. */
export function bandView(
  band: Band | undefined,
  actions: readonly NextAction[],
  columns: number,
  tier: GlyphTier,
  running = 0,
): BandView | undefined {
  if (band === undefined || (band.plan === null && band.error === null && actions.length === 0)) return undefined;
  return {
    status: statusRow(band, Math.max(0, columns - MARK_CELLS), tier, running),
    buttons: buttonRow(actions, usableColumns(columns), glyphs(tier)),
  };
}
