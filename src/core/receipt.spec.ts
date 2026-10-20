import { describe, expect, test } from "bun:test";
import { type GroupCall, receiptRow, shellReceipt } from "./receipt.ts";
import { glyphs } from "./ui-kit.ts";
import { piecesWidth, TONE_KEYS } from "./visual.ts";

const U = glyphs("unicode");
const A = glyphs("ascii");
const call = (command: string, extra: Partial<GroupCall> = {}): GroupCall => ({
  tool: "Bash",
  input: { command },
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  output: { stdout: "", stderr: "" },
  ...extra,
});
const text = (pieces: readonly { text: string }[]) => pieces.map((piece) => piece.text).join("");

describe("shellReceipt", () => {
  test("a passing verification run reports its last line of output", () => {
    expect(shellReceipt(call("just test", { output: { stdout: "running 12 tests\n\n12 pass, 0 fail\n", stderr: "" } }))).toEqual({
      command: "just test",
      state: "pass",
      exitCode: 0,
      summary: "12 pass, 0 fail",
    });
  });

  test("a failing run reports the exit code and the tool's own last line, not the runner's", () => {
    const output = "Exit code 1\nsrc/cart.ts:2:9 qty is not declared\n1 problem (1 error)\nerror: recipe `lint` failed on line 6 with exit code 1";
    expect(shellReceipt(call("just lint", { isErrored: true, output }))).toEqual({ command: "just lint", state: "fail", exitCode: 1, summary: "1 problem (1 error)" });
  });

  test("colors and links in the output are dropped from the summary", () => {
    const stdout = "\u001b[32m✓\u001b[0m 40 passed \u001b]8;;https://x.test\u0007report\u001b]8;;\u0007\n";
    expect(shellReceipt(call("bun test", { output: { stdout, stderr: "" } }))?.summary).toBe("✓ 40 passed report");
  });

  test("an interrupted run is stopped, with no summary", () => {
    expect(shellReceipt(call("cargo test", { isInterrupted: true }))).toEqual({ command: "cargo test", state: "stopped", exitCode: null, summary: "" });
  });

  test("a call that is not a finished verification run gets no receipt", () => {
    expect(shellReceipt(call("ls -la"))).toBeNull();
    expect(shellReceipt(call('echo "npm test"'))).toBeNull();
    expect(shellReceipt(call("just test", { isRunning: true }))).toBeNull();
    expect(shellReceipt({ ...call("just test"), tool: "Read" })).toBeNull();
  });

  test("PowerShell runs count as well", () => {
    expect(shellReceipt({ ...call("npm test"), tool: "PowerShell" })?.state).toBe("pass");
  });
});

describe("receiptRow", () => {
  const pass = { command: "just test", state: "pass", exitCode: 0, summary: "12 pass, 0 fail" } as const;
  const fail = { command: "just lint", state: "fail", exitCode: 1, summary: "1 problem (1 error)" } as const;

  test("hangs under the group with the result mark, the command and what it said", () => {
    expect(text(receiptRow(pass, U, 80))).toBe("  ⎿  ✓ just test · 12 pass, 0 fail");
    expect(text(receiptRow(fail, U, 80))).toBe("  ⎿  ✗ just lint · exit 1 · 1 problem (1 error)");
    expect(text(receiptRow({ command: "cargo test", state: "stopped", exitCode: null, summary: "" }, U, 80))).toBe("  ⎿  ⊘ cargo test · stopped");
  });

  test("colors the mark and a failure's exit code, and mutes the summary", () => {
    const pieces = receiptRow(fail, U, 80);
    expect(pieces.find((piece) => piece.text === "✗ ")?.color).toBe(TONE_KEYS.fail);
    expect(pieces.find((piece) => piece.text === "exit 1")?.color).toBe(TONE_KEYS.fail);
    expect(pieces.find((piece) => piece.text === "1 problem (1 error)")?.color).toBe(TONE_KEYS.muted);
  });

  test("cuts from the end to fit", () => {
    const row = receiptRow(fail, U, 30);
    expect(text(row)).toBe("  ⎿  ✗ just lint · exit 1 · 1…");
    expect(piecesWidth(row)).toBeLessThanOrEqual(30);
  });

  test("draws the ASCII set when asked", () => {
    expect(text(receiptRow(pass, A, 80))).toBe("  |  + just test - 12 pass, 0 fail");
  });
});
