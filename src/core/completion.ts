export type Word = { text: string; description?: string };

export type Slot = "subcommand" | "plan" | "rating";

export const SUBCOMMAND_WORDS: readonly Word[] = [
  { text: "plan", description: "Read a plan in the pane: /omca plan [name|path]" },
  { text: "stats", description: "Open the Stats tab" },
  { text: "doctor", description: "Check the environment" },
];

export const RATING_WORDS: readonly Word[] = [
  { text: "up", description: "The last turn went well" },
  { text: "down", description: "The last turn went badly" },
];

/** Which OMCA argument the token starting at `start` fills, judged by the draft before it. */
export function slotAt(text: string, start: number): Slot | undefined {
  const before = text.slice(0, start);
  if (/^\s*\/omca\s+$/.test(before)) return "subcommand";
  if (/^\s*\/omca\s+plan\s+$/.test(before)) return "plan";
  if (/^\s*\/omca-rate\s+$/.test(before)) return "rating";
  return undefined;
}

/** The words that begin with the token, ignoring case, short of the one already typed in full. */
export const matching = (words: readonly Word[], token: string): Word[] =>
  words.filter(({ text }) => text.toLowerCase().startsWith(token.toLowerCase()) && text !== token);
