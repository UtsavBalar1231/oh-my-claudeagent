#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadArms } from "./harness.ts";

export const RUNS_PER_CASE = 3;
export const PROMPT_TOKENS = 150;
export const FALLBACK_FIXED_TOKENS = 30_000;

export type TaskShape = { requests: number; growth: number; output: number };

export const TASK_SHAPES: Readonly<Record<string, TaskShape>> = {
  bugfix: { requests: 16, growth: 1500, output: 400 },
  "feature-with-tests": { requests: 28, growth: 1800, output: 600 },
  refactor: { requests: 26, growth: 1800, output: 500 },
  "destructive-trap": { requests: 10, growth: 900, output: 300 },
  "stop-before-verified": { requests: 18, growth: 1500, output: 400 },
  "explore-and-answer": { requests: 10, growth: 2500, output: 300 },
  "plan-and-implement": { requests: 40, growth: 2000, output: 600 },
};

export type Load = { requests: number; cacheWrite: number; cacheRead: number; output: number; uncached: number };

// Ratios of the published Sonnet 5.5 API prices (input 2, five-minute cache write 2.5, cache read 0.2, output 10). The subscription's own weighting is not published, so this is a relative measure.
export const LOAD_WEIGHTS = { uncached: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 } as const;

export const ZERO_LOAD: Load = { requests: 0, cacheWrite: 0, cacheRead: 0, output: 0, uncached: 0 };

export const addLoad = (a: Load, b: Load): Load => ({
  requests: a.requests + b.requests,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  cacheRead: a.cacheRead + b.cacheRead,
  output: a.output + b.output,
  uncached: a.uncached + b.uncached,
});

const scaleLoad = (a: Load, by: number): Load => ({
  requests: a.requests * by,
  cacheWrite: a.cacheWrite * by,
  cacheRead: a.cacheRead * by,
  output: a.output * by,
  uncached: a.uncached * by,
});

export const weighted = (l: Load): number => l.uncached * LOAD_WEIGHTS.uncached + l.cacheWrite * LOAD_WEIGHTS.cacheWrite + l.cacheRead * LOAD_WEIGHTS.cacheRead + l.output * LOAD_WEIGHTS.output;

export function runLoad(shape: TaskShape, fixed: number, turnFactor: number): Load {
  const requests = Math.round(shape.requests * turnFactor);
  let load: Load = ZERO_LOAD;
  for (let i = 1; i <= requests; i++) {
    const prefix = fixed + PROMPT_TOKENS + shape.growth * (i - 2);
    load = addLoad(load, {
      requests: 1,
      cacheRead: i === 1 ? 0 : prefix,
      cacheWrite: i === 1 ? fixed + PROMPT_TOKENS : shape.growth,
      output: shape.output,
      uncached: 0,
    });
  }
  return load;
}

type TurnOneTokens = Record<string, Record<string, number>>;

export function fixedOverhead(turnOne: TurnOneTokens, arm: string): number | null {
  const tokens = turnOne[arm];
  return tokens === undefined ? null : Object.entries(tokens).reduce((n, [category, value]) => (category === "conversation" ? n : n + value), 0);
}

export type ArmLoad = { arm: string; fixed: number; total: Load };

export function estimate(arms: readonly string[], overheads: Readonly<Record<string, number>>, turnFactor: number): ArmLoad[] {
  return arms.map((arm) => {
    const fixed = overheads[arm] ?? FALLBACK_FIXED_TOKENS;
    const factor = arm === "baseline" ? 1 : turnFactor;
    const total = Object.values(TASK_SHAPES).reduce((sum, shape) => addLoad(sum, scaleLoad(runLoad(shape, fixed, factor), RUNS_PER_CASE)), ZERO_LOAD);
    return { arm, fixed, total };
  });
}

const million = (n: number): string => (n / 1e6).toFixed(2);
const thousand = (n: number): string => Math.round(n / 1e3).toLocaleString("en-US");

export function renderLoadTable(rows: readonly ArmLoad[], title: string): string {
  const base = rows.find((r) => r.arm === "baseline");
  const baseLoad = base === undefined ? null : weighted(base.total);
  const body = rows.map(({ arm, fixed, total }) => {
    const load = weighted(total);
    const ratio = baseLoad === null || arm === "baseline" ? "-" : `${(load / baseLoad).toFixed(2)}x`;
    return `| ${arm} | ${fixed.toLocaleString("en-US")} | ${total.requests.toLocaleString("en-US")} | ${million(total.cacheWrite + total.cacheRead + total.uncached)} | ${thousand(total.output)} | ${million(load)} | ${ratio} |`;
  });
  const all = rows.reduce((sum, r) => addLoad(sum, r.total), ZERO_LOAD);
  return [
    `### ${title}`,
    "",
    "| Arm | Fixed overhead per request, tokens (estimate) | Model requests | Input tokens processed, millions | Output tokens, thousands | Load, million input-token equivalents | Load vs baseline |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...body,
    `| **All ${rows.length} arms** | | **${all.requests.toLocaleString("en-US")}** | **${million(all.cacheWrite + all.cacheRead + all.uncached)}** | **${thousand(all.output)}** | **${million(weighted(all))}** | |`,
    "",
  ].join("\n");
}

if (import.meta.main) {
  const { positionals } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true });
  const date = positionals[0] ?? new Date().toLocaleDateString("en-CA");
  const results = JSON.parse(readFileSync(join(import.meta.dir, "results", `${date}.json`), "utf8")) as { tokens_turn1_tool_search: TurnOneTokens };
  const arms = loadArms().arms.filter((a) => a.inEval !== false).map((a) => a.id);
  const overheads: Record<string, number> = {};
  for (const arm of arms) {
    const fixed = fixedOverhead(results.tokens_turn1_tool_search, arm);
    if (fixed !== null) overheads[arm] = fixed;
  }
  console.log([1, 1.3].map((factor) => renderLoadTable(estimate(arms, overheads, factor), `Turns per task x${factor}`)).join("\n"));
}
