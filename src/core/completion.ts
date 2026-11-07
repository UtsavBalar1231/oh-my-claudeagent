export type Word = { text: string; description?: string };

export const SUBCOMMAND_WORDS: readonly Word[] = [
  { text: "stats", description: "Open the Stats page" },
  { text: "doctor", description: "Check the environment" },
];

/** Whether the token starting at `start` fills /omca's subcommand, judged by the draft before it. */
export const isSubcommandSlot = (text: string, start: number): boolean => /^\s*\/omca\s+$/.test(text.slice(0, start));

/** The words that begin with the token, ignoring case, short of the one already typed in full. */
export const matching = (words: readonly Word[], token: string): Word[] =>
  words.filter(({ text }) => text.toLowerCase().startsWith(token.toLowerCase()) && text !== token);
