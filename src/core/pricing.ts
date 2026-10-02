export const PRICING_AS_OF = "2026-10-02";

const LIST_PRICES = "https://platform.claude.com/docs/en/about-claude/pricing#model-pricing, read 2026-10-02";

// US cents per million tokens, so a cost is one integer sum and a single division. Cache writes
// take the 5-minute rate: a usage reports no TTL. Fast mode, batch and data-residency rates are
// not applied.
type Price = { input: number; cacheRead: number; cacheWrite: number; output: number; source: string };

const PRICES: Readonly<Record<string, Price>> = {
  "fable-5.1": { input: 1000, cacheRead: 25, cacheWrite: 1250, output: 5000, source: LIST_PRICES },
  "mythos-5.1": { input: 1000, cacheRead: 25, cacheWrite: 1250, output: 5000, source: LIST_PRICES },
  "fable-5": { input: 1000, cacheRead: 100, cacheWrite: 1250, output: 5000, source: LIST_PRICES },
  "mythos-5": { input: 1000, cacheRead: 100, cacheWrite: 1250, output: 5000, source: LIST_PRICES },
  "opus-5.5": { input: 400, cacheRead: 20, cacheWrite: 500, output: 2000, source: LIST_PRICES },
  "opus-5": { input: 500, cacheRead: 50, cacheWrite: 625, output: 2500, source: LIST_PRICES },
  "opus-4.8": { input: 500, cacheRead: 50, cacheWrite: 625, output: 2500, source: LIST_PRICES },
  "opus-4.7": { input: 500, cacheRead: 50, cacheWrite: 625, output: 2500, source: LIST_PRICES },
  "opus-4.6": { input: 500, cacheRead: 50, cacheWrite: 625, output: 2500, source: LIST_PRICES },
  "opus-4.5": { input: 500, cacheRead: 50, cacheWrite: 625, output: 2500, source: LIST_PRICES },
  "opus-4.1": { input: 1500, cacheRead: 150, cacheWrite: 1875, output: 7500, source: LIST_PRICES },
  "opus-4": { input: 1500, cacheRead: 150, cacheWrite: 1875, output: 7500, source: LIST_PRICES },
  "sonnet-5.5": { input: 200, cacheRead: 20, cacheWrite: 250, output: 1000, source: LIST_PRICES },
  "sonnet-5": { input: 200, cacheRead: 20, cacheWrite: 250, output: 1000, source: LIST_PRICES },
  "sonnet-4.6": { input: 300, cacheRead: 30, cacheWrite: 375, output: 1500, source: LIST_PRICES },
  "sonnet-4.5": { input: 300, cacheRead: 30, cacheWrite: 375, output: 1500, source: LIST_PRICES },
  "sonnet-4": { input: 300, cacheRead: 30, cacheWrite: 375, output: 1500, source: LIST_PRICES },
  "haiku-4.5": { input: 100, cacheRead: 10, cacheWrite: 125, output: 500, source: LIST_PRICES },
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

/** Estimated USD at list price, or null when the model has no sourced price. */
export function estimateCostUsd(model: string, usage: Usage): number | null {
  const price = priceOf(model);
  if (price === undefined) return null;
  const cents =
    usage.input_tokens * price.input +
    usage.cache_read_input_tokens * price.cacheRead +
    usage.cache_creation_input_tokens * price.cacheWrite +
    usage.output_tokens * price.output;
  return cents / 1e8;
}
