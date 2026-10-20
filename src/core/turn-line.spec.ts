import { describe, expect, test } from "bun:test";
import { turnDuration, turnFacts, type TurnRecord, turnLine } from "./turn-line.ts";
import { displayWidth, glyphs } from "./ui-kit.ts";
import { piecesWidth, TONE_KEYS } from "./visual.ts";

const U = glyphs("unicode");
const RECORD: TurnRecord = {
  turnId: "t-1",
  startedAt: 0,
  endedAt: 21_000,
  tokens: { input: 26_600, output: 48 },
  costUsd: 0.1082,
  receipt: { command: "just test", at: 20, isLogged: false },
  waiting: [],
};
const LINE = { word: "Cooked", durationMs: 21_219, doneAt: "3:35 AM", waiting: [], record: RECORD };
const text = (pieces: readonly { text: string }[]) => pieces.map((piece) => piece.text).join("");
const ran = (command: string): TurnRecord => ({ ...RECORD, receipt: { command, at: 20, isLogged: false } });

describe("turnDuration", () => {
  test("words a duration the way the engine's turn line does", () => {
    expect([0, 734, 21_219, 64_000, 7_500_000].map(turnDuration)).toEqual(["0s", "0s", "21s", "1m 4s", "2h 5m"]);
  });
});

describe("turnLine", () => {
  test("reads the engine's word and duration, then the clock, tokens, cost and receipt", () => {
    expect(text(turnLine(LINE, U, 200))).toBe("Cooked for 21s · done 3:35 AM · 26.6k in 48 out · $0.1082 · ! just test not logged");
  });

  test("draws every word dim and colors only the receipt's mark", () => {
    const pieces = turnLine(LINE, U, 200);
    const mark = pieces.find((piece) => piece.text === "! ");
    expect(mark).toEqual({ text: "! ", color: TONE_KEYS.warn });
    expect(pieces.filter((piece) => piece !== mark).every((piece) => piece.dimColor === true)).toBe(true);
  });

  test("a logged receipt reads logged with the check mark", () => {
    const pieces = turnLine({ ...LINE, record: { ...RECORD, receipt: { command: "just test", at: 20, isLogged: true } } }, U, 200);
    expect(text(pieces)).toEndWith("· ✓ just test logged");
    expect(pieces.find((piece) => piece.text === "✓ ")?.color).toBe(TONE_KEYS.ok);
  });

  test("a narrowing row gives up the clock, then the cost, then the tokens, and keeps the receipt", () => {
    const widths = [82, 81, 80, 70, 60, 45, 36];
    expect(widths.map((width) => text(turnLine(LINE, U, width)))).toEqual([
      "Cooked for 21s · done 3:35 AM · 26.6k in 48 out · $0.1082 · ! just test not logged",
      "Cooked for 21s · 26.6k in 48 out · $0.1082 · ! just test not logged",
      "Cooked for 21s · 26.6k in 48 out · $0.1082 · ! just test not logged",
      "Cooked for 21s · 26.6k in 48 out · $0.1082 · ! just test not logged",
      "Cooked for 21s · 26.6k in 48 out · ! just test not logged",
      "Cooked for 21s · ! just test not logged",
      "Cooked for 21s · ! just… not logged",
    ]);
    for (const width of widths) expect(piecesWidth(turnLine(LINE, U, width))).toBeLessThanOrEqual(width);
  });

  test("a command of up to 16 cells is cut only once no part is left to give up", () => {
    const widths = [89, 88, 45];
    expect(widths.map((width) => text(turnLine({ ...LINE, record: ran("npx tsc --noEmit") }, U, width)))).toEqual([
      "Cooked for 21s · done 3:35 AM · 26.6k in 48 out · $0.1082 · ! npx tsc --noEmit not logged",
      "Cooked for 21s · 26.6k in 48 out · $0.1082 · ! npx tsc --noEmit not logged",
      "Cooked for 21s · ! npx tsc --noEm… not logged",
    ]);
  });

  test("a longer command is cut to keep the parts, down to 8 cells of it", () => {
    const widths = [88, 81, 80];
    expect(widths.map((width) => text(turnLine({ ...LINE, record: ran("bun run typecheck") }, U, width)))).toEqual([
      "Cooked for 21s · done 3:35 AM · 26.6k in 48 out · $0.1082 · ! bun run typech… not logged",
      "Cooked for 21s · done 3:35 AM · 26.6k in 48 out · $0.1082 · ! bun run… not logged",
      "Cooked for 21s · 26.6k in 48 out · $0.1082 · ! bun run typecheck not logged",
    ]);
  });

  test("a turn with nothing recorded is the engine's line", () => {
    const bare = { ...RECORD, tokens: null, costUsd: null, receipt: null };
    expect(text(turnLine({ ...LINE, doneAt: null, record: bare }, U, 80))).toBe("Cooked for 21s");
  });

  test("a turn that waits on agents names them in their own colors", () => {
    const pieces = turnLine({ ...LINE, waiting: ["oh-my-claudeagent:executor", "oh-my-claudeagent:architect"] }, U, 200);
    expect(text(pieces)).toStartWith("Waiting for executor, architect · done 3:35 AM");
    expect(pieces.find((piece) => piece.text === "executor")?.color).toBe("green_FOR_SUBAGENTS_ONLY");
    expect(pieces.find((piece) => piece.text === "architect")?.color).toBe("purple_FOR_SUBAGENTS_ONLY");
  });

  test("agents of one type are named once with their count", () => {
    const waiting = ["oh-my-claudeagent:executor", "oh-my-claudeagent:explorer", "oh-my-claudeagent:executor"];
    expect(text(turnLine({ ...LINE, waiting, record: { ...RECORD, receipt: null } }, U, 200))).toStartWith("Waiting for executor ×2, explorer · ");
    expect(text(turnLine({ ...LINE, waiting, record: { ...RECORD, receipt: null } }, glyphs("ascii"), 200))).toStartWith("Waiting for executor x2, explorer - ");
  });
});

describe("turnFacts", () => {
  test("starts at the first fact, with no clock and no leading dot", () => {
    expect(text(turnFacts(RECORD, U, 80))).toBe("26.6k in 48 out · $0.1082 · ! just test not logged");
    expect(text(turnFacts({ ...RECORD, tokens: null, costUsd: null }, U, 80))).toBe("! just test not logged");
    expect(turnFacts({ ...RECORD, tokens: null, costUsd: null, receipt: null }, U, 80)).toEqual([]);
  });

  test("gives up a part before it cuts a short command, and cuts a longer one first", () => {
    expect(text(turnFacts(RECORD, U, 49))).toBe("26.6k in 48 out · ! just test not logged");
    expect(text(turnFacts(ran("bun run typecheck"), U, 49))).toBe("26.6k in 48 out · $0.1082 · ! bun run… not logged");
  });

  test("fits its cells", () => {
    expect(displayWidth(text(turnFacts(RECORD, U, 30)))).toBeLessThanOrEqual(30);
  });
});
