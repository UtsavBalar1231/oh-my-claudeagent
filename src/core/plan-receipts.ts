import type { Proof, Verdict } from "./proof.ts";
import { displayWidth, fitEnd, type Glyphs, oneLine } from "./ui-kit.ts";
import { fitPieces, type Piece, TONE_KEYS } from "./visual.ts";

export type TaskReceipt = { n: number; title: string; proof: Proof | null; command: string | null };
export type PlanComplete = { proven: number; unproven: number; failed: number; isVerified: boolean };

/** One placed transcript row: the tasks a main turn finished and, when they ended the plan, the plan's outcome. */
export type Receipt = {
  id: string;
  plan: string;
  path: string;
  total: number;
  tasks: readonly TaskReceipt[];
  complete: PlanComplete | null;
};

const RECEIPT_PREFIX = "receipt-";
// A row whose facts leave the atom draws nothing, so the cap sits past any session's finished tasks.
export const KEPT_RECEIPTS = 200;
// More tasks than this finishing in one turn fold into a count, so a bulk edit of a plan stays a short row.
const SHOWN_TASKS = 6;
// A command this short stays whole; a longer one keeps at least `MIN_COMMAND` cells beside the title.
const WHOLE_COMMAND = 16;
const MIN_COMMAND = 8;
// Below this many cells a title is left out, since an ellipsis after the task number reads as a cut number.
const MIN_TITLE = 4;

export const receiptId = (at: number, sequence: number): string => `${RECEIPT_PREFIX}${at.toString(36)}-${sequence}`;

export const isReceiptId = (id: string): boolean => id.startsWith(RECEIPT_PREFIX);

/** The newest proving run names the verdict: the pass that proved it or the failure that broke it. */
export function taskReceipt(card: { n: number; title: string }, verdict: Verdict | undefined): TaskReceipt {
  const proof = verdict?.proof ?? null;
  const command = proof === "proven" || proof === "failed" ? (verdict?.since[0]?.command ?? null) : null;
  return { n: card.n, title: oneLine(card.title), proof, command };
}

function settledTask(task: TaskReceipt, current: TaskReceipt | undefined): TaskReceipt {
  if (current === undefined || task.proof === "proven") return task;
  const isCloser = current.proof === "proven" || (current.proof === "failed" && task.proof !== "failed");
  return isCloser ? { ...task, proof: current.proof, command: current.command } : task;
}

function settledOutcome(stored: PlanComplete, current: PlanComplete | null): PlanComplete {
  if (current === null || stored.isVerified) return stored;
  return current.isVerified || current.proven > stored.proven ? current : stored;
}

/**
 * The receipt once later evidence has settled it. A row moves only toward proof, because evidence
 * often lands after the turn that finished a task. Proof is per file, so work on a later task can
 * make an earlier one read unproven again; that is the band's and the Plan tab's live verdict, and a
 * row that said proven keeps saying it. A task no longer on the plan keeps what it said, and so
 * does a plan no longer complete.
 */
export function settled(receipt: Receipt, tasks: ReadonlyMap<number, TaskReceipt>, complete: PlanComplete | null): Receipt {
  return {
    ...receipt,
    tasks: receipt.tasks.map((task) => settledTask(task, tasks.get(task.n))),
    complete: receipt.complete === null ? null : settledOutcome(receipt.complete, complete),
  };
}

const dim = (text: string): Piece => ({ text, dimColor: true });

function markOf(proof: Proof | null, g: Glyphs): Piece {
  switch (proof) {
    case "proven":
      return { text: `${g.check} `, color: TONE_KEYS.ok };
    case "unproven":
      return { text: `${g.warn} `, color: TONE_KEYS.warn };
    case "failed":
      return { text: `${g.cross} `, color: TONE_KEYS.fail };
    case null:
      return { text: `${g.check} `, dimColor: true };
  }
}

const PROOF_WORDS: Readonly<Record<Proof, string>> = { proven: "proven by ", unproven: "unproven", failed: "failed " };

function taskRow(task: TaskReceipt, g: Glyphs, columns: number): Piece[] {
  const mark = markOf(task.proof, g);
  const label = `Task ${task.n}`;
  const dot = ` ${g.dot} `;
  const words = task.proof === null ? "" : PROOF_WORDS[task.proof];
  const command = oneLine(task.command ?? "");
  const fixed = displayWidth(mark.text) + displayWidth(label) + (words === "" ? 0 : displayWidth(dot) + displayWidth(words));
  const keptCommand = Math.min(displayWidth(command), displayWidth(command) <= WHOLE_COMMAND ? WHOLE_COMMAND : MIN_COMMAND);
  const titleRoom = columns - fixed - keptCommand - 1;
  const title = titleRoom < MIN_TITLE ? "" : fitEnd(oneLine(task.title), titleRoom, g.ellipsis);
  const used = fixed + (title === "" ? 0 : 1 + displayWidth(title));
  const tail = words === "" ? [] : [dim(dot), dim(`${words}${fitEnd(command, Math.max(0, columns - used), g.ellipsis)}`)];
  return fitPieces([mark, { text: label }, ...(title === "" ? [] : [{ text: ` ${title}` }]), ...tail], columns, g.ellipsis);
}

function countPieces({ proven, unproven, failed }: PlanComplete, g: Glyphs): Piece[] {
  const kinds = [
    [proven, "proven", "proven" as const],
    [unproven, "unproven", "unproven" as const],
    [failed, "failed", "failed" as const],
  ] as const;
  return kinds
    .filter(([count]) => count > 0)
    .flatMap(([count, word, proof], index) => [...(index === 0 ? [] : [dim(" ")]), markOf(proof, g), dim(`${count} ${word}`)]);
}

function planRow(receipt: Receipt, complete: PlanComplete, g: Glyphs, columns: number): Piece[] {
  const dot = dim(` ${g.dot} `);
  const head: Piece[] = [markOf(complete.isVerified ? "proven" : "unproven", g), { text: `Plan ${oneLine(receipt.plan)} complete` }];
  const final = [dim(complete.isVerified ? "final verification passed" : "final verification not logged")];
  const tally = [dim(`${receipt.total}/${receipt.total}`)];
  const counts = countPieces(complete, g);
  const joined = (segments: readonly (readonly Piece[])[]): Piece[] => [...head, ...segments.flatMap((pieces) => [dot, ...pieces])];
  const width = (pieces: readonly Piece[]): number => pieces.reduce((sum, piece) => sum + displayWidth(piece.text), 0);
  // The counts leave first as the row narrows, then the tally; what the verification says stays.
  const choices = [[tally, ...(counts.length === 0 ? [] : [counts]), final], [tally, final], [final]];
  const chosen = choices.map(joined).find((pieces) => width(pieces) <= columns) ?? joined([final]);
  return fitPieces(chosen, columns, g.ellipsis);
}

/** The rows a receipt draws in `columns` cells: a row per task, the tasks past the limit as a count, then the plan's outcome. */
export function receiptRows(receipt: Receipt, g: Glyphs, columns: number): Piece[][] {
  const shown = receipt.tasks.slice(0, SHOWN_TASKS);
  const hidden = receipt.tasks.length - shown.length;
  return [
    ...shown.map((task) => taskRow(task, g, columns)),
    ...(hidden === 0 ? [] : [[dim(`+${hidden} more ${hidden === 1 ? "task" : "tasks"}`)]]),
    ...(receipt.complete === null ? [] : [planRow(receipt, receipt.complete, g, columns)]),
  ];
}
