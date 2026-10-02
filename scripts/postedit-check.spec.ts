import { describe, expect, test } from "bun:test";
import { report } from "./postedit-check.ts";

const edit = (file: string) => JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file } });

function counting(result: { ok: boolean; output: string }) {
  const calls = { count: 0 };
  return { calls, typecheck: () => ((calls.count += 1), result) };
}

describe("report", () => {
  test("a .ts edit that typechecks reports nothing", () => {
    const { calls, typecheck } = counting({ ok: true, output: "" });
    expect(report(edit("/repo/servers/omca.ts"), typecheck)).toBe("");
    expect(calls.count).toBe(1);
  });

  test("a .ts edit that fails the typecheck reports the first 20 output lines as additionalContext", () => {
    const output = Array.from({ length: 30 }, (_, i) => `error ${i}`).join("\n");
    const { typecheck } = counting({ ok: false, output });
    const parsed = JSON.parse(report(edit("/repo/src/a.ts"), typecheck));
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput.additionalContext.split("\n")).toEqual(output.split("\n").slice(0, 20));
  });

  test("an edit to any other file never runs the typecheck", () => {
    const { calls, typecheck } = counting({ ok: false, output: "boom" });
    expect(report(edit("/repo/README.md"), typecheck)).toBe("");
    expect(report(edit("/repo/justfile"), typecheck)).toBe("");
    expect(calls.count).toBe(0);
  });

  test("a payload that is not an edit object, or not JSON, never runs the typecheck", () => {
    const { calls, typecheck } = counting({ ok: false, output: "boom" });
    for (const stdin of ["", "{not json", "[]", "null", JSON.stringify({ tool_input: "x" }), JSON.stringify({ tool_input: { file_path: 3 } })]) {
      expect(report(stdin, typecheck)).toBe("");
    }
    expect(calls.count).toBe(0);
  });
});
