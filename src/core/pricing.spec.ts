import { expect, test } from "bun:test";
import { estimateCostUsd } from "./pricing.ts";

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
});

test.each([
  ["claude-sonnet-5-5", usage(1_000_000, 0), 2],
  ["claude-sonnet-5-5", usage(0, 1_000_000), 10],
  ["claude-opus-5-5", usage(1200, 300), 0.0108],
  ["claude-opus-5-5", usage(0, 0, 1_000_000, 0), 0.2],
  ["claude-opus-5-5", usage(0, 0, 0, 1_000_000), 5],
  ["claude-fable-5-1", usage(10_000, 2_000, 100_000, 4_000), 0.275],
  ["claude-haiku-4-5-20251001", usage(1_000_000, 1_000_000), 6],
  ["claude-opus-4-1-20250805", usage(1_000_000, 0), 15],
  ["claude-opus-4-20250514", usage(1_000_000, 0), 15],
  ["us.anthropic.claude-sonnet-4-5-20250929-v1:0", usage(1_000_000, 0), 3],
  ["claude-opus-5-5[1m]", usage(0, 0), 0],
])("%s %j costs $%p", (model, tokens, usd) => {
  expect(estimateCostUsd(model, tokens)).toBe(usd);
});

test.each(["mock-model", "claude-3-5-haiku-20241022", "claude-opus-9-9", "gpt-5", ""])("%p has no sourced price", (model) => {
  expect(estimateCostUsd(model, usage(1000, 1000))).toBeNull();
});
