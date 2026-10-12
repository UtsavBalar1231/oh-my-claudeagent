import { fitEnd, formatDuration, formatTokens, type Glyphs, oneLine } from "./ui-kit.ts";

// An 80-column terminal draws a plugin's turn text on a 72-cell row after `● oh-my-claudeagent: `
// (measured), so 51 cells keep the footer on one row.
export const FOOTER_WIDTH = 51;

export type Footer = {
  durationMs: number;
  tokens: { input: number; output: number } | null;
  costUsd: number | null;
  unlogged: string | null;
};

const dollars = (usd: number) => `$${usd.toFixed(Math.abs(usd) < 1 ? 4 : 2)}`;

// The warning takes the cost's place, since the two do not fit on the row together.
function tail({ costUsd, unlogged }: Footer, g: Glyphs): string[] {
  if (unlogged !== null) return [`${g.warn} no evidence: ${oneLine(unlogged)}`];
  return costUsd === null ? [] : [`${dollars(costUsd)} engine cost`];
}

const NO_BREAK_SPACE = "\u00a0";

// The engine wraps at spaces, so a unit's own words are joined with no-break spaces and only the
// dots between units are break points.
export function footerLine(footer: Footer, g: Glyphs): string {
  const { tokens } = footer;
  const parts = [
    formatDuration(footer.durationMs),
    ...(tokens === null ? [] : [`${formatTokens(tokens.input)} in ${formatTokens(tokens.output)} out`]),
    ...tail(footer, g),
  ];
  return fitEnd(parts.map((part) => part.replaceAll(" ", NO_BREAK_SPACE)).join(` ${g.dot} `), FOOTER_WIDTH, g.ellipsis);
}
