import { describe, expect, test } from "bun:test";
import { type GroupCall, glyphTestLine, glyphTestRow, receiptRow, shellReceipt } from "./receipt.ts";
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

describe("glyphTestLine", () => {
  const printed = "\uf05d \uf085 \uf06e \uf120";
  const test4 = (command: string, extra: Partial<GroupCall> = {}) => call(command, { output: { stdout: `${printed}\n`, stderr: "" }, ...extra });

  test("a finished run of the script with the flag yields the line it printed, glyphs untouched", () => {
    expect(glyphTestLine(test4('bun "${CLAUDE_PLUGIN_ROOT}/scripts/setup-statusline.ts" --glyph-test'))).toBe(printed);
    expect(glyphTestLine(test4("bun /home/me/.claude/plugins/cache/omca/scripts/setup-statusline.ts --glyph-test"))).toBe(printed);
    expect(glyphTestLine(test4("cd /work && bun run scripts/setup-statusline.ts --glyph-test | cat"))).toBe(printed);
    expect(glyphTestLine({ ...test4("bun scripts/setup-statusline.ts --glyph-test"), tool: "PowerShell" })).toBe(printed);
  });

  test("takes the last non-empty line and drops colors", () => {
    const stdout = `warning\n\u001b[32m${printed}\u001b[0m\n\n`;
    expect(glyphTestLine(test4("bun scripts/setup-statusline.ts --glyph-test", { output: { stdout, stderr: "" } }))).toBe(printed);
    expect(glyphTestLine(test4("bun scripts/setup-statusline.ts --glyph-test", { output: { stdout: "\n", stderr: "" } }))).toBeNull();
  });

  test("a command that only mentions the script or the flag yields nothing", () => {
    expect(glyphTestLine(test4('echo "--glyph-test"'))).toBeNull();
    expect(glyphTestLine(test4('echo "bun scripts/setup-statusline.ts --glyph-test"'))).toBeNull();
    expect(glyphTestLine(test4("echo bun scripts/setup-statusline.ts --glyph-test"))).toBeNull();
    expect(glyphTestLine(test4("bun scripts/setup-statusline.ts --settings s.json"))).toBeNull();
    expect(glyphTestLine(test4("bun scripts/other.ts --glyph-test"))).toBeNull();
  });

  test("a running, failed or stopped call, or another tool, yields nothing", () => {
    const command = "bun scripts/setup-statusline.ts --glyph-test";
    expect(glyphTestLine(test4(command, { isRunning: true }))).toBeNull();
    expect(glyphTestLine(test4(command, { isErrored: true, output: "Exit code 1" }))).toBeNull();
    expect(glyphTestLine(test4(command, { isInterrupted: true }))).toBeNull();
    expect(glyphTestLine({ ...test4(command), tool: "Read" })).toBeNull();
  });
});

describe("glyphTestRow", () => {
  const printed = "\uf05d \uf085 \uf06e \uf120";

  test("hangs a muted label and the printed line under the group", () => {
    const row = glyphTestRow(printed, U, 80);
    expect(text(row)).toBe(`  ⎿  glyph test ${printed}`);
    expect(row.find((piece) => piece.text === "glyph test ")?.color).toBe(TONE_KEYS.muted);
    expect(row.at(-1)).toEqual({ text: printed });
  });

  test("keeps the glyphs whole at a narrow width by dropping the label", () => {
    const row = glyphTestRow(printed, U, 14);
    expect(text(row)).toBe(`  ⎿  ${printed}`);
    expect(piecesWidth(row)).toBeLessThanOrEqual(14);
    expect(text(glyphTestRow(printed, U, 8))).toBe(`  ⎿  ${printed}`);
  });

  test("uses the ASCII indent on the ASCII tier and never swaps the glyphs for its own", () => {
    expect(text(glyphTestRow(printed, A, 80))).toBe(`  |  glyph test ${printed}`);
  });
});
