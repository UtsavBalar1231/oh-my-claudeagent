import { outsideFences, TASK_LINE } from "./checkboxes.ts";
import type { NextAction, NextActionKind } from "./next-actions.ts";
import { displayWidth, fitEnd, type Glyphs, usableColumns } from "./ui-kit.ts";

export type NextTask = { n: number; title: string };
export type Proof = { proven: number; unproven: number; failed: number };

export type Band = {
  plan: { name: string; path: string; done: number; total: number; next: NextTask | null } | null;
  verification: { command: string; at: number; isLogged: boolean } | null;
  proof?: Proof;
  error: string | null;
  readAt: number;
};

export type Tone = "title" | "plain" | "muted" | "ok" | "warn" | "fail" | "active" | "fill" | "track";
export type Span = { text: string; tone: Tone };
export type BandButton = { key: NextActionKind; hotkey: string; label: string; prompt: string };
export type BandView = { status: readonly Span[]; buttons: readonly BandButton[] };

type Part = Span & { isFlexible?: true };
type Words = { noPlan: string; logged: string; unlogged: string };

const FULL: Words = { noPlan: "no plan bound", logged: " evidence logged", unlogged: " evidence not logged" };
const COMPACT: Words = { noPlan: "no plan", logged: " logged", unlogged: " not logged" };

// Below this many cells a flexible part (task title, command) stops reading as a name.
const MIN_FLEXIBLE = 14;
const BAR_CELLS = 5;
export const BUTTON_GAP = 3;
// A plain Button draws its hotkey, a colon and a space before the label.
const HOTKEY_CELLS = 3;

// The order a narrowing band gives segments up in, last first: progress is the one fact that
// always stays, then whether agents run, what comes next, the proof, then the verification.
const PRIORITY = { progress: 1, running: 2, next: 3, proof: 4, unlogged: 5, logged: 6 } as const;

export const oneLine = (text: string): string => text.replace(/[\s\p{Cc}]+/gu, " ").trim();

/** Water-fills `room` cells over the wants: the smaller wants are met whole, the rest split evenly. */
export function share(wants: readonly number[], room: number): number[] {
  const sizes = wants.map(() => 0);
  const order = wants.map((_, index) => index).sort((a, b) => (wants[a] ?? 0) - (wants[b] ?? 0));
  let left = Math.max(0, room);
  order.forEach((index, rank) => {
    const size = Math.min(wants[index] ?? 0, Math.floor(left / (order.length - rank)));
    sizes[index] = size;
    left -= size;
  });
  return sizes;
}

export type Ranked = { priority: number; min: number };

/**
 * The segments that fit `room` cells with `gap` cells between neighbours, in their own order.
 * While they do not fit, the one with the largest priority number goes, the later one on a tie;
 * the last segment standing is kept whatever its size.
 */
export function arrange<T extends Ranked>(segments: readonly T[], room: number, gap: number): T[] {
  let kept = [...segments];
  const need = (list: readonly T[]) => list.reduce((sum, segment) => sum + segment.min, 0) + gap * Math.max(0, list.length - 1);
  while (kept.length > 1 && need(kept) > room) {
    const last = kept.reduce((worst, segment) => (segment.priority >= worst.priority ? segment : worst));
    kept = kept.filter((segment) => segment !== last);
  }
  return kept;
}

/** The numbered tasks' tally and the first open one, read the way every plan reader reads them. */
export function planTally(text: string): { done: number; total: number; next: NextTask | null } {
  const tasks = outsideFences(text)
    .split("\n")
    .flatMap((line) => {
      const task = TASK_LINE.exec(line);
      return task === null ? [] : [task];
    });
  const open = tasks.find((task) => task[1] !== "x");
  return {
    done: tasks.filter((task) => task[1] === "x").length,
    total: tasks.length,
    next: open === undefined ? null : { n: Number(open[2]), title: oneLine(open[3] ?? "") },
  };
}

const widthOf = (spans: readonly Span[]): number => spans.reduce((sum, span) => sum + displayWidth(span.text), 0);

/** Five cells: any progress shows one, and only a finished plan fills them all. */
export function progressCells(done: number, total: number): number {
  if (total <= 0 || done <= 0) return 0;
  if (done >= total) return BAR_CELLS;
  return Math.min(BAR_CELLS - 1, Math.max(1, Math.round((done / total) * BAR_CELLS)));
}

type Segment = Ranked & { parts: Part[] };

const segment = (priority: number, parts: Part[]): Segment => ({
  priority,
  parts,
  min: parts.reduce((sum, part) => sum + (part.isFlexible ? Math.min(MIN_FLEXIBLE, displayWidth(part.text)) : displayWidth(part.text)), 0),
});

function proofParts({ proven, unproven, failed }: Proof, g: Glyphs): Part[] {
  return [
    { text: `${g.check}${proven}`, tone: proven > 0 ? "ok" : "muted" },
    { text: " ", tone: "muted" },
    { text: `${g.warn}${unproven}`, tone: unproven > 0 ? "warn" : "muted" },
    { text: " ", tone: "muted" },
    { text: `${g.cross}${failed}`, tone: failed > 0 ? "fail" : "muted" },
  ];
}

function statusSegments(band: Band, words: Words, g: Glyphs, running: number): Segment[] {
  if (band.error !== null) return [segment(0, [{ text: `${g.cross} ${oneLine(band.error)}`, tone: "fail", isFlexible: true }])];
  const { plan, verification, proof } = band;
  const segments: Segment[] = [];
  if (plan === null) {
    segments.push(segment(PRIORITY.progress, [{ text: words.noPlan, tone: "muted" }]));
  } else {
    const filled = progressCells(plan.done, plan.total);
    segments.push(
      segment(PRIORITY.progress, [
        { text: g.filled.repeat(filled), tone: "fill" },
        { text: g.empty.repeat(BAR_CELLS - filled), tone: "track" },
        { text: ` ${plan.done}/${plan.total}`, tone: "muted" },
      ]),
    );
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
  if (proof !== undefined) segments.push(segment(PRIORITY.proof, proofParts(proof, g)));
  if (verification !== null) {
    const { isLogged } = verification;
    segments.push(
      segment(isLogged ? PRIORITY.logged : PRIORITY.unlogged, [
        { text: `${isLogged ? g.check : g.warn} `, tone: isLogged ? "ok" : "warn" },
        { text: oneLine(verification.command), tone: "plain", isFlexible: true },
        { text: isLogged ? words.logged : words.unlogged, tone: isLogged ? "muted" : "warn" },
      ]),
    );
  }
  if (running > 0) {
    segments.push(segment(PRIORITY.running, [{ text: `${g.agent} ${running} running`, tone: "active" }]));
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
  return parts.map(({ text, tone, isFlexible }) => ({
    text: isFlexible ? fitEnd(text, sizes[flexible++] ?? 0, g.ellipsis) : text,
    tone,
  }));
}

function clip(spans: readonly Span[], width: number, g: Glyphs): Span[] {
  if (widthOf(spans) <= width) return spans.filter((span) => span.text !== "");
  const out: Span[] = [];
  let left = width;
  for (const span of spans) {
    const cells = displayWidth(span.text);
    if (cells >= left) {
      out.push({ text: fitEnd(`${span.text}${g.ellipsis}`, left, g.ellipsis), tone: span.tone });
      break;
    }
    if (cells > 0) out.push(span);
    left -= cells;
  }
  return out.filter((span) => span.text !== "");
}

function statusRow(band: Band, width: number, g: Glyphs, running: number): Span[] {
  const gap = displayWidth(` ${g.dot} `);
  const full = statusSegments(band, FULL, g, running);
  const kept = arrange(full, width, gap);
  const chosen = kept.length === full.length ? kept : arrange(statusSegments(band, COMPACT, g, running), width, gap);
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
  g: Glyphs,
  running = 0,
): BandView | undefined {
  if (band === undefined || (band.plan === null && band.error === null && actions.length === 0)) return undefined;
  const width = usableColumns(columns);
  return { status: statusRow(band, width, g, running), buttons: buttonRow(actions, width, g) };
}
