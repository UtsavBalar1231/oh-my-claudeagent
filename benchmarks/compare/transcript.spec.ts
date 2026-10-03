import { describe, expect, test } from "bun:test";
import { finalText, hitUsageLimit, parseTranscript } from "./transcript.ts";

const line = (event: unknown): string => JSON.stringify(event);
const assistant = (...content: unknown[]): string => line({ type: "assistant", message: { content } });
const result = (fields: Record<string, unknown>): string => line({ type: "result", subtype: "success", is_error: false, ...fields });

const SAMPLE = [
  line({ type: "system", subtype: "init" }),
  assistant({ type: "text", text: "Looking" }, { type: "tool_use", name: "Read", input: { file_path: "/a" } }),
  line({ type: "user", message: { content: [{ type: "tool_result", content: "x" }] } }),
  "not json",
  assistant({ type: "tool_use", name: "Bash", input: { command: "bun test" } }, { type: "text", text: "All done" }),
  result({ num_turns: 3, duration_ms: 1500, result: "Final answer", usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 } }),
].join("\n");

describe("parseTranscript", () => {
  const parsed = parseTranscript(SAMPLE);

  test("lists every tool call in order with its input", () => {
    expect(parsed.toolUses).toEqual([
      { name: "Read", input: { file_path: "/a" } },
      { name: "Bash", input: { command: "bun test" } },
    ]);
  });

  test("keeps the last assistant text and reads the result event", () => {
    expect(parsed.lastAssistantText).toBe("All done");
    expect(parsed.result).toEqual({
      isError: false,
      subtype: "success",
      turns: 3,
      durationMs: 1500,
      usage: { input: 10, output: 20, cacheWrite: 30, cacheRead: 40 },
      text: "Final answer",
    });
  });

  test("returns no result for a run that ended without one", () => {
    expect(parseTranscript(assistant({ type: "text", text: "partial" })).result).toBeNull();
  });

  test("treats missing usage fields as zero", () => {
    expect(parseTranscript(result({ result: "r" })).result?.usage).toEqual({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
  });
});

describe("finalText", () => {
  test("prefers the result text and falls back to the last assistant text", () => {
    expect(finalText(parseTranscript(SAMPLE))).toBe("Final answer");
    expect(finalText(parseTranscript(assistant({ type: "text", text: "only this" })))).toBe("only this");
  });
});

describe("hitUsageLimit", () => {
  const failed = (text: string): ReturnType<typeof parseTranscript> => parseTranscript(result({ is_error: true, subtype: "error_during_execution", result: text }));

  test("recognises the plan limit and rate-limit messages in a failed result", () => {
    expect(hitUsageLimit(failed("You've hit your session limit · your session limit resets 3:45pm"), "")).toBe(true);
    expect(hitUsageLimit(failed("You've hit your weekly limit"), "")).toBe(true);
    expect(hitUsageLimit(failed("API Error: Request rejected (429)"), "")).toBe(true);
  });

  test("ignores the same words in a successful answer", () => {
    expect(hitUsageLimit(parseTranscript(result({ result: "A usage limit is a cap" })), "")).toBe(false);
  });

  test("falls back to stderr only when the run produced no result", () => {
    expect(hitUsageLimit(parseTranscript(""), "You've hit your session limit")).toBe(true);
    expect(hitUsageLimit(parseTranscript(SAMPLE), "usage limit in a plugin log")).toBe(false);
  });

  test("does not flag an ordinary failure", () => {
    expect(hitUsageLimit(failed("Error: max turns reached"), "")).toBe(false);
  });
});
