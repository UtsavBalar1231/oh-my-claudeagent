import { describe, expect, test } from "bun:test";
import { EVAL_CASES } from "./cases.ts";
import { estimate, fixedOverhead, renderLoadTable, runLoad, TASK_SHAPES, weighted } from "./cost.ts";

describe("runLoad", () => {
  const shape = { requests: 3, growth: 100, output: 10 };

  test("writes the prefix once, then reads it and writes only the growth", () => {
    expect(runLoad(shape, 1000, 1)).toEqual({ requests: 3, cacheWrite: 1350, cacheRead: 2400, output: 30, uncached: 0 });
  });

  test("rounds the request count after scaling it", () => {
    expect(runLoad(shape, 1000, 1.3)).toEqual({ requests: 4, cacheWrite: 1450, cacheRead: 3750, output: 40, uncached: 0 });
  });
});

describe("weighted", () => {
  test("applies the price ratios of cache writes, cache reads and output", () => {
    expect(weighted({ requests: 3, cacheWrite: 1350, cacheRead: 2400, output: 30, uncached: 0 })).toBe(2077.5);
  });

  test("counts uncached input at face value", () => {
    expect(weighted({ requests: 1, cacheWrite: 0, cacheRead: 0, output: 0, uncached: 10 })).toBe(10);
  });
});

describe("fixedOverhead", () => {
  test("sums every category except the conversation", () => {
    expect(fixedOverhead({ a: { system_prompt: 100, tools_mcp: 20, conversation: 50 } }, "a")).toBe(120);
  });

  test("has no answer for an arm without a measurement", () => {
    expect(fixedOverhead({}, "a")).toBeNull();
  });
});

describe("TASK_SHAPES", () => {
  test("has a shape for every eval case and no other", () => {
    expect(Object.keys(TASK_SHAPES).sort()).toEqual(EVAL_CASES.map((c) => c.id).sort());
  });
});

describe("estimate", () => {
  test("keeps baseline at the measured turns and scales the plugin arms", () => {
    const [baseline, plugin] = estimate(["baseline", "plugin"], { baseline: 1000, plugin: 2000 }, 2);
    expect([baseline?.fixed, baseline?.total.requests]).toEqual([1000, 444]);
    expect([plugin?.fixed, plugin?.total.requests]).toEqual([2000, 888]);
  });

  test("falls back to a fixed overhead for an unmeasured arm", () => {
    expect(estimate(["new"], {}, 1)[0]?.fixed).toBe(30000);
  });
});

describe("renderLoadTable", () => {
  test("renders millions, thousands and the ratio to baseline", () => {
    const rows = [
      { arm: "baseline", fixed: 1000, total: { requests: 10, cacheWrite: 2e6, cacheRead: 1e6, output: 50000, uncached: 0 } },
      { arm: "x", fixed: 2000, total: { requests: 20, cacheWrite: 4e6, cacheRead: 2e6, output: 100000, uncached: 0 } },
    ];
    expect(renderLoadTable(rows, "Title").split("\n")).toEqual([
      "### Title",
      "",
      "| Arm | Fixed overhead per request, tokens (estimate) | Model requests | Input tokens processed, millions | Output tokens, thousands | Load, million input-token equivalents | Load vs baseline |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| baseline | 1,000 | 10 | 3.00 | 50 | 2.85 | - |",
      "| x | 2,000 | 20 | 6.00 | 100 | 5.70 | 2.00x |",
      "| **All 2 arms** | | **30** | **9.00** | **150** | **8.55** | |",
      "",
    ]);
  });
});
