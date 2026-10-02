import { describe, expect, test } from "bun:test";
import { agentScenario, bashScenario, mcpCommand, median, pairOrder, readSessionLog, type SessionLog, summarize } from "./bench.ts";

const logLine = (fields: { client?: string; queue?: string; tool_results?: number; arrival_ms: number }) =>
  JSON.stringify({ client: "127.0.0.1", queue: "main", tool_results: 0, ...fields });

describe("median", () => {
  test("takes the middle sample of an odd count regardless of input order", () => {
    expect(median([9, 1, 5])).toBe(5);
  });

  test("averages the two middle samples of an even count", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  test("leaves the caller's array unsorted", () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
  });

  test("refuses an empty sample", () => {
    expect(() => median([])).toThrow("median of no samples");
  });
});

describe("summarize", () => {
  test("reports the median of the paired differences, not the difference of the medians", () => {
    expect(summarize([10, 20, 30], [11, 30, 29])).toEqual({
      n: 3,
      baseline_median: 20,
      candidate_median: 29,
      median_paired_diff: 1,
      median_paired_diff_pct: 5,
    });
  });

  test("gives a negative difference when the candidate is faster", () => {
    expect(summarize([8, 8], [6, 7]).median_paired_diff).toBe(-1.5);
  });

  test("refuses samples of different lengths", () => {
    expect(() => summarize([1, 2], [1])).toThrow("paired samples differ in length");
  });
});

describe("pairOrder", () => {
  test("alternates which side runs first", () => {
    expect([0, 1, 2, 3].map(pairOrder)).toEqual([
      ["baseline", "candidate"],
      ["candidate", "baseline"],
      ["baseline", "candidate"],
      ["candidate", "baseline"],
    ]);
  });
});

describe("readSessionLog", () => {
  test("measures the first request from the spawn and the window from first to last request", () => {
    const log = [
      logLine({ arrival_ms: 1_500 }),
      logLine({ queue: "subagent", arrival_ms: 1_600 }),
      logLine({ tool_results: 2, arrival_ms: 1_900 }),
    ].join("\n");

    expect(readSessionLog(`${log}\n`, 1_000)).toEqual({
      first_request_ms: 500,
      window_ms: 400,
      main_requests: 2,
      subagent_requests: 1,
      final_tool_results: 2,
    });
  });

  test("takes the tool result count from the last main request, not the sum", () => {
    const log = [0, 1, 2, 3].map((n, i) => logLine({ tool_results: n, arrival_ms: i })).join("\n");

    expect(readSessionLog(log, 0).final_tool_results).toBe(3);
  });

  test("rejects a log with a request from outside localhost", () => {
    const log = [logLine({ arrival_ms: 1 }), logLine({ client: "10.0.0.7", arrival_ms: 2 })].join("\n");

    expect(() => readSessionLog(log, 0)).toThrow("requests from outside 127.0.0.1: 10.0.0.7");
  });

  test("rejects an empty log, since the client never reached the mock", () => {
    expect(() => readSessionLog("", 0)).toThrow("the mock logged no request");
  });
});

describe("scenario checks", () => {
  const session = (overrides: Partial<SessionLog>): SessionLog => ({
    first_request_ms: 0,
    window_ms: 0,
    main_requests: 21,
    subagent_requests: 0,
    final_tool_results: 20,
    ...overrides,
  });

  test("the Bash scenario accepts 20 results in the last of 21 main requests", () => {
    expect(bashScenario.check(session({}))).toBeNull();
  });

  test("the Bash scenario rejects a run that saw fewer results", () => {
    expect(bashScenario.check(session({ final_tool_results: 19 }))).toBe(
      "expected 20 Bash results in the last of 21 main requests, got 19 in the last of 21",
    );
  });

  test("the Agent scenario requires exactly 5 subagent requests", () => {
    expect(agentScenario.check(session({ subagent_requests: 5 }))).toBeNull();
    expect(agentScenario.check(session({ subagent_requests: 4 }))).toBe("expected 5 subagent requests, got 4");
  });
});

describe("mcpCommand", () => {
  test("expands the plugin root and data placeholders in the omca entry's args and env", () => {
    const mcpJson = JSON.stringify({
      mcpServers: {
        omca: {
          command: "uv",
          args: ["run", "--project", "${CLAUDE_PLUGIN_ROOT}/servers", "python", "${CLAUDE_PLUGIN_ROOT}/servers/omca-mcp.py"],
          env: { UV_PROJECT_ENVIRONMENT: "${CLAUDE_PLUGIN_DATA}/.venv" },
        },
        grep: { type: "http", url: "https://mcp.grep.app" },
      },
    });

    expect(mcpCommand(mcpJson, "/p", "/d")).toEqual({
      cmd: ["uv", "run", "--project", "/p/servers", "python", "/p/servers/omca-mcp.py"],
      env: { UV_PROJECT_ENVIRONMENT: "/d/.venv" },
    });
  });

  test("accepts an entry without env, as a bun-launched server has", () => {
    const mcpJson = JSON.stringify({ mcpServers: { omca: { command: "bun", args: ["${CLAUDE_PLUGIN_ROOT}/servers/omca.ts"] } } });

    expect(mcpCommand(mcpJson, "/p", "/d")).toEqual({ cmd: ["bun", "/p/servers/omca.ts"], env: {} });
  });

  test("refuses a config without an omca server", () => {
    expect(() => mcpCommand(JSON.stringify({ mcpServers: {} }), "/p", "/d")).toThrow("no omca server in .mcp.json");
  });
});
