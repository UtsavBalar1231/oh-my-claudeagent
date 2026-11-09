import { isHookDisabled } from "../src/core/kill-switch.ts";
import { type Refusal, refusalOf } from "../src/core/refusals.ts";
import { fitEnd, type Glyphs, glyphs } from "../src/core/ui-kit.ts";
import { fitPieces, type Piece, piecesWidth, TONE_KEYS } from "../src/core/visual.ts";
import type { Features } from "./dispatch.ts";
import { resolvedSession } from "./host.ts";
import { taskSubject } from "./task-list.ts";
import { isRemote, kitOf, Line } from "./ui.ts";

// A cell kept free at the row's end, as the transcript's other OMCA rows keep it.
const GUTTER = 1;
// The engine draws a result's mark two cells in and its text five cells in, on every line.
const MARK_INDENT = "  ";
const TEXT_INDENT = "     ";

type Shape = { mark: string; head: Piece[]; note: string | undefined };

function shapeOf(refusal: Refusal, subject: string | undefined, g: Glyphs, columns: number): Shape | undefined {
  const dot: Piece = { text: ` ${g.dot} `, color: TONE_KEYS.muted };
  switch (refusal.kind) {
    case "guard":
      return { mark: g.blocked, head: [{ text: "OMCA guard refused" }, dot, { text: refusal.title }], note: refusal.remedy };
    case "review-refused":
      return { mark: g.blocked, head: [{ text: "you refused this in the OMCA guard" }], note: "Claude asks how to proceed" };
    case "final-kept":
    case "final-unlogged": {
      if (refusal.taskId === undefined) return undefined;
      const id: Piece = { text: `#${refusal.taskId}` };
      const tail: Piece[] = [dot, { text: refusal.title }];
      const room = columns - TEXT_INDENT.length - piecesWidth([id, ...tail]) - 1;
      const shown = subject === undefined ? "" : fitEnd(subject, room, g.ellipsis);
      return { mark: g.cross, head: [id, ...(shown === "" ? [] : [{ text: ` ${shown}` }]), ...tail], note: refusal.remedy };
    }
    case "ledger-invalid":
      return { mark: g.cross, head: [{ text: refusal.title }], note: refusal.remedy };
    case "comment":
      return { mark: g.warn, head: [{ text: "OMCA comment check held this write" }, dot, { text: refusal.detail ?? refusal.title }], note: refusal.remedy };
    case "completion-held":
    case "verification-unlogged":
      return undefined;
  }
}

function blockerLines(refusal: Refusal, subject: string | undefined, g: Glyphs, columns: number): Piece[][] | undefined {
  const shape = shapeOf(refusal, subject, g, columns);
  if (shape === undefined) return undefined;
  const first: Piece[] = [{ text: MARK_INDENT }, { text: shape.mark, color: TONE_KEYS.fail }, { text: MARK_INDENT }, ...shape.head];
  const second: Piece[][] = shape.note === undefined ? [] : [[{ text: TEXT_INDENT }, { text: shape.note, color: TONE_KEYS.muted }]];
  return [first, ...second].map((pieces) => fitPieces(pieces, columns, g.ellipsis));
}

// A standalone result whose text is one of OMCA's refusals draws OMCA's compact row in the normal
// view. ctrl+o, a client that does not say which view it draws, and a remote surface keep the
// engine's row, whose text is the reason the model read.
export const blockerRows: Features = {
  "ui.render ToolResult": {
    pre(host, e) {
      const { output, isErrored, isExpanded } = e.props;
      if (isErrored !== true || isExpanded !== false || typeof output !== "string") return undefined;
      const { glyphTier, disabledHooks } = resolvedSession();
      if (isHookDisabled(disabledHooks, "blocker-rows")) return undefined;
      const kit = kitOf(host.ui.resolve(e), e.surface);
      if (isRemote(kit)) return undefined;
      const refusal = refusalOf(output);
      if (refusal === undefined) return undefined;
      const subject = refusal.taskId === undefined ? undefined : taskSubject(refusal.taskId);
      const lines = blockerLines(refusal, subject, glyphs(glyphTier), (e.viewport?.columns ?? 80) - GUTTER);
      if (lines === undefined) return undefined;
      return { answer: kit.Box({ key: "omca-blocker-rows", flexDirection: "column", children: lines.map((pieces) => Line(kit, pieces)) }) };
    },
  },
};
