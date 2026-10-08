export const PRICING_AS_OF = "2026-10-08";

// List prices from https://platform.claude.com/docs/en/about-claude/pricing#model-pricing, read 2026-10-08.
// US cents per million tokens, halves included, so a cost is an exact sum and a single division.
// Cache writes take the 5-minute rate: a usage reports no TTL. Fast mode, batch and
// data-residency rates are not applied. A model priced by prompt length takes its `over` rates
// for a request whose prompt (input, cache reads and cache writes) passes `tokens`.
type Rates = { input: number; cacheRead: number; cacheWrite: number; output: number };
type Price = Rates & { over?: { tokens: number; rates: Rates } };

const PRICES: Readonly<Record<string, Price>> = {
  "fable-5.1": { input: 1000, cacheRead: 25, cacheWrite: 1250, output: 5000 },
  "mythos-5.1": { input: 1000, cacheRead: 25, cacheWrite: 1250, output: 5000 },
  "fable-5": { input: 1000, cacheRead: 100, cacheWrite: 1250, output: 5000 },
  "mythos-5": { input: 1000, cacheRead: 100, cacheWrite: 1250, output: 5000 },
  "opus-5.5": { input: 400, cacheRead: 20, cacheWrite: 500, output: 2000 },
  "opus-5": { input: 500, cacheRead: 50, cacheWrite: 625, output: 2500 },
  "opus-4.8": { input: 500, cacheRead: 50, cacheWrite: 625, output: 2500 },
  "opus-4.7": { input: 500, cacheRead: 50, cacheWrite: 625, output: 2500 },
  "opus-4.6": { input: 500, cacheRead: 50, cacheWrite: 625, output: 2500 },
  "opus-4.5": { input: 500, cacheRead: 50, cacheWrite: 625, output: 2500 },
  "opus-4.1": { input: 1500, cacheRead: 150, cacheWrite: 1875, output: 7500 },
  "opus-4": { input: 1500, cacheRead: 150, cacheWrite: 1875, output: 7500 },
  "sonnet-5.5": { input: 200, cacheRead: 10, cacheWrite: 250, output: 1000 },
  "sonnet-5": { input: 200, cacheRead: 20, cacheWrite: 250, output: 1000 },
  "sonnet-4.6": { input: 300, cacheRead: 30, cacheWrite: 375, output: 1500 },
  "sonnet-4.5": { input: 300, cacheRead: 30, cacheWrite: 375, output: 1500 },
  "sonnet-4": { input: 300, cacheRead: 30, cacheWrite: 375, output: 1500 },
  "haiku-5.5": {
    input: 10,
    cacheRead: 1,
    cacheWrite: 12.5,
    output: 50,
    over: { tokens: 100_000, rates: { input: 50, cacheRead: 5, cacheWrite: 62.5, output: 250 } },
  },
  "haiku-4.5": { input: 100, cacheRead: 10, cacheWrite: 125, output: 500 },
};

// claude-opus-4-1-20250805 is opus 4.1 and claude-opus-4-20250514 is opus 4: a minor version
// has at most two digits, a date suffix eight.
const MODEL_ID = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/;

function priceOf(model: string): Price | undefined {
  const match = MODEL_ID.exec(model);
  if (match === null) return undefined;
  const [, family, major, minor] = match;
  return PRICES[`${family}-${major}${minor === undefined ? "" : `.${minor}`}`];
}

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

/** Estimated USD at list price for one request's usage, or null when the model has no sourced price. */
export function estimateCostUsd(model: string, usage: Usage): number | null {
  const base = priceOf(model);
  if (base === undefined) return null;
  const prompt = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
  const price = base.over !== undefined && prompt > base.over.tokens ? base.over.rates : base;
  const cents =
    usage.input_tokens * price.input +
    usage.cache_read_input_tokens * price.cacheRead +
    usage.cache_creation_input_tokens * price.cacheWrite +
    usage.output_tokens * price.output;
  return cents / 1e8;
}

/**
 * Dollars to the cent, rounded through the table's integer unit so $2.855 shows as $2.86
 * rather than as the float just below it; a cost under a cent but above zero is `<$0.01`.
 */
export function formatUsd(usd: number): string {
  const cents = Math.round(Math.round(usd * 1e8) / 1e6);
  if (cents === 0 && usd > 0) return "<$0.01";
  return `$${(cents / 100).toFixed(2)}`;
}
