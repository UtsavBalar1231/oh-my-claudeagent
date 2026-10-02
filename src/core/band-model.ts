import type { NextAction, NextActionKind } from "./next-actions.ts";
import { displayWidth, fitEnd, type Glyphs, usableColumns } from "./ui-kit.ts";

export type Band = {
  plan: { name: string; path: string; done: number; total: number } | null;
  verification: { command: string; at: number; isLogged: boolean } | null;
  error: string | null;
  readAt: number;
};

export type Tone = "title" | "plain" | "muted" | "ok" | "warn" | "fail";
export type Span = { text: string; tone: Tone };
export type BandButton = { key: NextActionKind; hotkey: string; label: string; prompt: string };
export type BandView = { status: readonly Span[]; buttons: readonly BandButton[] };

type Part = Span & { isFlexible?: true };
type Words = { tasks: string; noPlan: string; unverified: string; logged: string; unlogged: string };

const FULL: Words = {
  tasks: " tasks",
  noPlan: "no plan bound",
  unverified: "no verification yet",
  logged: " evidence logged",
  unlogged: " evidence not logged",
};
const COMPACT: Words = { tasks: "", noPlan: "no plan", unverified: "unverified", logged: " logged", unlogged: " not logged" };

// Below this many cells a flexible part (plan name, command) stops reading as a name.
const MIN_FLEXIBLE = 8;
export const BUTTON_GAP = 3;
// A plain Button draws its hotkey, a colon and a space before the label.
const HOTKEY_CELLS = 3;

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

const widthOf = (spans: readonly Span[]): number => spans.reduce((sum, span) => sum + displayWidth(span.text), 0);

function statusParts(band: Band, words: Words, g: Glyphs): Part[] {
  if (band.error !== null) return [{ text: `${g.cross} ${oneLine(band.error)}`, tone: "fail", isFlexible: true }];
  const { plan, verification } = band;
  const parts: Part[] =
    plan === null
      ? [{ text: words.noPlan, tone: "muted" }]
      : [
          { text: oneLine(plan.name), tone: "title", isFlexible: true },
          { text: ` ${plan.done}/${plan.total}${words.tasks}`, tone: "muted" },
        ];
  if (plan === null && verification === null) return parts;
  parts.push({ text: ` ${g.dot} `, tone: "muted" });
  if (verification === null) return [...parts, { text: words.unverified, tone: "muted" }];
  const { isLogged } = verification;
  return [
    ...parts,
    { text: `${isLogged ? g.check : g.warn} `, tone: isLogged ? "ok" : "warn" },
    { text: oneLine(verification.command), tone: "plain", isFlexible: true },
    { text: isLogged ? words.logged : words.unlogged, tone: isLogged ? "muted" : "warn" },
  ];
}

const fixedWidth = (parts: readonly Part[]): number =>
  parts.reduce((sum, part) => sum + (part.isFlexible ? 0 : displayWidth(part.text)), 0);

const fits = (parts: readonly Part[], width: number): boolean =>
  fixedWidth(parts) +
    parts.reduce((sum, part) => sum + (part.isFlexible ? Math.min(MIN_FLEXIBLE, displayWidth(part.text)) : 0), 0) <=
  width;

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

function statusRow(band: Band, width: number, g: Glyphs): Span[] {
  const full = statusParts(band, FULL, g);
  if (fits(full, width)) return clip(fitParts(full, width, g), width, g);
  return clip(fitParts(statusParts(band, COMPACT, g), width, g), width, g);
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
): BandView | undefined {
  if (band === undefined || (band.plan === null && band.error === null && actions.length === 0)) return undefined;
  const width = usableColumns(columns);
  return { status: statusRow(band, width, g), buttons: buttonRow(actions, width, g) };
}
