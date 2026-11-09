import type { NextAction, NextActionKind } from "./next-actions.ts";
import { bandRunLine, type RunSummary } from "./run-line.ts";
import { displayWidth, fitEnd, type Glyphs, glyphs, type GlyphTier, oneLine, share, usableColumns } from "./ui-kit.ts";
import { type Piece, piecesWidth } from "./visual.ts";

export type Band = {
  error: string | null;
  readAt: number;
};

export type Tone = "plain" | "muted" | "ok" | "warn" | "fail";
export type Span = { text: string; tone: Tone };
export type BandButton = { key: NextActionKind; hotkey: string; label: string; prompt: string };
export type BandView = { status: readonly Span[]; run: readonly Piece[]; buttons: readonly BandButton[] };

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

// The error takes what the glyph leaves.
function statusRow(band: Band, width: number, tier: GlyphTier): Span[] {
  if (band.error === null) return [];
  const g = glyphs(tier);
  const lead: Span = { text: `${g.cross} `, tone: "fail" };
  const fit: Span = { text: fitEnd(oneLine(band.error), Math.max(0, width - displayWidth(lead.text)), g.ellipsis), tone: "plain" };
  return clip([lead, fit], width, g);
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
  if (band === undefined || (band.error === null && actions.length === 0 && run === undefined)) return undefined;
  const room = Math.max(0, columns - MARK_CELLS);
  return {
    status: statusRow(band, room, tier),
    run: run === undefined ? [] : bandRunLine(run, glyphs(tier), room),
    buttons: buttonRow(actions, usableColumns(columns), glyphs(tier)),
  };
}
