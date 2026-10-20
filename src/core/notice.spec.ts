import { describe, expect, test } from "bun:test";
import { launchRow, type Notice, noticeRows, noticeStatus } from "./notice.ts";
import { glyphs } from "./ui-kit.ts";
import { piecesWidth, TONE_KEYS } from "./visual.ts";

const U = glyphs("unicode");
const A = glyphs("ascii");
const NOTICE: Notice = {
  type: "oh-my-claudeagent:architect",
  description: "Review the rounding rule",
  status: "answer",
  durationMs: 3_270,
  calls: 1,
  tokens: 11_900,
  result: "Rounding at the end is right; rounding each line would drift by a cent.",
};
const text = (pieces: readonly { text: string }[]) => pieces.map((piece) => piece.text).join("");

describe("noticeStatus", () => {
  test("the engine's word for how the task ended outranks the recorded status", () => {
    expect(noticeStatus("failed", "answer")).toBe("error");
    expect(noticeStatus("killed", "answer")).toBe("aborted");
    expect(noticeStatus("completed", "error")).toBe("answer");
    expect(noticeStatus(undefined, "refusal")).toBe("refusal");
    expect(noticeStatus("archived", "gone")).toBe("gone");
  });
});

describe("noticeRows", () => {
  test("a finished agent: mark, role and task, the facts flush right, and its reply beneath", () => {
    const [head, said] = noticeRows(NOTICE, U, 80).map(text);
    expect(head).toBe(`✓ architect  Review the rounding rule${" ".repeat(20)}3s · 1 call · 11.9k tok`);
    expect(head).toHaveLength(80);
    expect(said).toBe("  ⎿  Rounding at the end is right; rounding each line would drift by a cent.");
  });

  test("the role draws in its agent color and the facts muted", () => {
    const [head = []] = noticeRows(NOTICE, U, 80);
    expect(head[0]).toEqual({ text: "✓ ", color: TONE_KEYS.ok });
    expect(head[1]).toEqual({ text: "architect", color: "purple_FOR_SUBAGENTS_ONLY", bold: true });
    expect(head.at(-1)).toEqual({ text: "11.9k tok", color: TONE_KEYS.muted });
  });

  test("a failed or stopped agent says so in the facts, in the matching color", () => {
    const [failed = []] = noticeRows({ ...NOTICE, status: "error" }, U, 80);
    expect(failed[0]).toEqual({ text: "✗ ", color: TONE_KEYS.fail });
    expect(failed.find((piece) => piece.text === "failed")?.color).toBe(TONE_KEYS.fail);
    const [stopped = []] = noticeRows({ ...NOTICE, status: "aborted" }, U, 80);
    expect(stopped.find((piece) => piece.text === "stopped")?.color).toBe(TONE_KEYS.warn);
  });

  test("a narrowing row drops the tokens, then the calls, before the task is cut", () => {
    const widths = [62, 61, 50, 49, 30];
    expect(widths.map((width) => text(noticeRows(NOTICE, U, width)[0] ?? []))).toEqual([
      "✓ architect  Review the rounding rule  3s · 1 call · 11.9k tok",
      `✓ architect  Review the rounding rule${" ".repeat(13)}3s · 1 call`,
      "✓ architect  Review the rounding rule  3s · 1 call",
      `✓ architect  Review the rounding rule${" ".repeat(10)}3s`,
      "✓ architect  Review the r…  3s",
    ]);
    for (const width of widths) for (const row of noticeRows(NOTICE, U, width)) expect(piecesWidth(row)).toBeLessThanOrEqual(width);
  });

  test("an agent that said nothing gets one row, and one with no figures no facts", () => {
    expect(noticeRows({ ...NOTICE, result: "" }, U, 80)).toHaveLength(1);
    expect(text(noticeRows({ ...NOTICE, durationMs: null, calls: 0, tokens: 0, result: "" }, U, 80)[0] ?? [])).toBe("✓ architect  Review the rounding rule");
  });

  test("draws the ASCII set when asked", () => {
    expect(noticeRows(NOTICE, A, 80).map(text)[1]).toBe("  |  Rounding at the end is right; rounding each line would drift by a cent.");
  });
});

describe("launchRow", () => {
  const LAUNCH = { type: "oh-my-claudeagent:executor", description: "Wire the order summary panel", isBackground: true, state: "done" } as const;

  test("a background launch keeps the agent's icon in its color, with background flush right", () => {
    const row = launchRow(LAUNCH, U, 80);
    expect(text(row)).toBe(`◆ executor  Wire the order summary panel${" ".repeat(30)}background`);
    expect(row[0]).toEqual({ text: "◆ ", color: "green_FOR_SUBAGENTS_ONLY" });
    expect(row[1]).toEqual({ text: "executor", color: "green_FOR_SUBAGENTS_ONLY", bold: true });
    expect(row.at(-1)).toEqual({ text: "background", color: TONE_KEYS.muted });
  });

  test("a background launch that failed or was stopped shows that mark, not the agent's icon", () => {
    expect(launchRow({ ...LAUNCH, state: "failed" }, U, 80)[0]).toEqual({ text: "✗ ", color: TONE_KEYS.fail });
    expect(launchRow({ ...LAUNCH, state: "stopped" }, U, 80)[0]).toEqual({ text: "! ", color: TONE_KEYS.warn });
  });

  test("a call that waits for its agent shows the icon while it runs, then how it ended", () => {
    const waited = { ...LAUNCH, isBackground: false };
    expect(text(launchRow({ ...waited, state: "running" }, U, 80))).toBe("◆ executor  Wire the order summary panel");
    expect(launchRow({ ...waited, state: "done" }, U, 80)[0]).toEqual({ text: "✓ ", color: TONE_KEYS.ok });
    expect(launchRow({ ...waited, state: "failed" }, U, 80)[0]).toEqual({ text: "✗ ", color: TONE_KEYS.fail });
    expect(launchRow({ ...waited, state: "stopped" }, U, 80)[0]).toEqual({ text: "! ", color: TONE_KEYS.warn });
  });

  test("a narrow row cuts the task and drops background before the name", () => {
    expect(text(launchRow(LAUNCH, U, 40))).toBe("◆ executor  Wire the order…   background");
    expect(text(launchRow(LAUNCH, U, 34))).toBe("◆ executor  Wire the order summar…");
    expect(text(launchRow(LAUNCH, U, 24))).toBe("◆ executor  Wire the or…");
    for (const width of [80, 40, 34, 24]) expect(piecesWidth(launchRow(LAUNCH, U, width))).toBeLessThanOrEqual(width);
  });
});
