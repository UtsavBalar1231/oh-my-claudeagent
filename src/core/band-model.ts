import type { NextAction, NextActionKind } from "./next-actions.ts";
import { bandRunLine, type RunSummary } from "./run-line.ts";
import { displayWidth, fitEnd, type Glyphs, glyphs, type GlyphTier, oneLine, share, usableColumns } from "./ui-kit.ts";
import { type Piece, piecesWidth } from "./visual.ts";

export type Band = {
  verification: { command: string; at: number; isLogged: boolean } | null;
  error: string | null;
  readAt: number;
};

export type Tone = "plain" | "muted" | "ok" | "warn" | "fail";
export type Span = { text: string; tone: Tone };
export type BandButton = { key: NextActionKind; hotkey: string; label: string; prompt: string };
export type BandView = { status: readonly Span[]; run: readonly Piece[]; buttons: readonly BandButton[] };

const FULL = { logged: " evidence logged", unlogged: " evidence not logged" };
const COMPACT = { logged: " logged", unlogged: " not logged" };

// Below this many cells a command stops reading as a name, so the shorter wording takes the room.
const MIN_COMMAND = 14;
export const BUTTON_GAP = 3;
// The engine draws the band's collapse mark, `[-]`, over the last three columns of its first row,
// so the status row and the run line, either of which can be first, stop one column short of it.
const MARK_CELLS = 4;
// A plain Button draws its hotkey, a colon and a space before the label.
const HOTKEY_CELLS = 3;

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

// The subject takes what the spans around it leave.
function fitted(lead: Span, subject: string, tail: Span | undefined, width: number, g: Glyphs): Span[] {
  const room = width - displayWidth(lead.text) - displayWidth(tail?.text ?? "");
  const fit: Span = { text: fitEnd(subject, Math.max(0, room), g.ellipsis), tone: "plain" };
  return clip([lead, fit, ...(tail === undefined ? [] : [tail])], width, g);
}

function verificationRow({ command, isLogged }: NonNullable<Band["verification"]>, width: number, g: Glyphs): Span[] {
  const lead: Span = { text: `${isLogged ? g.check : g.warn} `, tone: isLogged ? "ok" : "warn" };
  const subject = oneLine(command);
  const wordsOf = ({ logged, unlogged }: typeof FULL) => (isLogged ? logged : unlogged);
  const need = displayWidth(lead.text) + Math.min(MIN_COMMAND, displayWidth(subject)) + displayWidth(wordsOf(FULL));
  const words = wordsOf(need <= width ? FULL : COMPACT);
  return fitted(lead, subject, { text: words, tone: isLogged ? "muted" : "plain" }, width, g);
}

function statusRow(band: Band, width: number, tier: GlyphTier): Span[] {
  const g = glyphs(tier);
  if (band.error !== null) return fitted({ text: `${g.cross} `, tone: "fail" }, oneLine(band.error), undefined, width, g);
  return band.verification === null ? [] : verificationRow(band.verification, width, g);
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

/** Nothing to draw (undefined) until the first snapshot, and while no section has content. `run` is an open run. */
export function bandView(band: Band | undefined, actions: readonly NextAction[], columns: number, tier: GlyphTier, run: RunSummary | undefined): BandView | undefined {
  if (band === undefined || (band.verification === null && band.error === null && actions.length === 0 && run === undefined)) return undefined;
  const room = Math.max(0, columns - MARK_CELLS);
  return {
    status: statusRow(band, room, tier),
    run: run === undefined ? [] : bandRunLine(run, glyphs(tier), room),
    buttons: buttonRow(actions, usableColumns(columns), glyphs(tier)),
  };
}
