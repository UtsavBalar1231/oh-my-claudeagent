import { describe, expect, test } from "bun:test";
import { type Band, bandView, BUTTON_GAP } from "./band-model.ts";
import { type NextAction, nextActions } from "./next-actions.ts";
import type { RunSummary } from "./run-line.ts";
import { displayWidth, type GlyphTier, usableColumns } from "./ui-kit.ts";

const UNLOGGED = { command: "just test", at: 1_790_000_000, isLogged: false };
const LOGGED = { ...UNLOGGED, isLogged: true };
const band = (fields: Partial<Band>): Band => ({ verification: null, error: null, readAt: 0, ...fields });
const actionsOf = (b: Band): NextAction[] => nextActions({ verification: b.verification, isRunOpen: false });
const RUN: RunSummary = { name: "dotman-rewrite", done: 5, total: 27, running: ["6", "7"], blocked: ["8"], isOpen: true };
const text = (spans: readonly { text: string }[]): string => spans.map((span) => span.text).join("");
const status = (b: Band, columns: number, tier: GlyphTier = "unicode"): string => text(bandView(b, actionsOf(b), columns, tier, undefined)?.status ?? []);

describe("bandView", () => {
  test("draws nothing before the first snapshot", () => {
    expect(bandView(undefined, [], 120, "unicode", undefined)).toBeUndefined();
  });

  test("draws nothing with no verification, no error and no action", () => {
    expect(bandView(band({}), [], 120, "unicode", undefined)).toBeUndefined();
  });

  test("an unlogged verification: the glyph warns and the words stay plain", () => {
    expect(bandView(band({ verification: UNLOGGED }), [], 120, "unicode", undefined)?.status).toEqual([
      { text: "! ", tone: "warn" },
      { text: "just test", tone: "plain" },
      { text: " evidence not logged", tone: "plain" },
    ]);
  });

  test("a logged verification: the glyph is ok and the words are muted", () => {
    expect(bandView(band({ verification: LOGGED }), [], 120, "unicode", undefined)?.status).toEqual([
      { text: "✓ ", tone: "ok" },
      { text: "just test", tone: "plain" },
      { text: " evidence logged", tone: "muted" },
    ]);
  });

  test("as the band narrows the wording shortens before the command is cut", () => {
    const b = band({ verification: UNLOGGED });
    expect(status(b, 120)).toBe("! just test evidence not logged");
    expect(status(b, 35)).toBe("! just test evidence not logged");
    expect(status(b, 30)).toBe("! just test not logged");
    expect(status(b, 20)).toBe("! ju… not logged");
  });

  test("a read error is one line, its glyph in the fail tone, whatever else is known", () => {
    const b = band({ verification: UNLOGGED, error: "Cannot read the session status file:\nUnexpected token" });
    expect(bandView(b, [], 120, "unicode", undefined)?.status).toEqual([
      { text: "✗ ", tone: "fail" },
      { text: "Cannot read the session status file: Unexpected token", tone: "plain" },
    ]);
  });

  test("ASCII glyphs replace every symbol", () => {
    expect(status(band({ verification: LOGGED }), 120, "ascii")).toBe("+ just test evidence logged");
    expect(status(band({ verification: UNLOGGED }), 120, "ascii")).toBe("! just test evidence not logged");
    expect(status(band({ error: "boom" }), 120, "ascii")).toBe("x boom");
  });

  test("a command spanning lines or holding control characters reads as one line", () => {
    const b = band({ verification: { ...LOGGED, command: "just\ttest \\\n  --verbose\u001b[31m" } });
    expect(status(b, 120)).toBe("✓ just test \\ --verbose [31m evidence logged");
  });

  test("the log action takes the first hotkey and fills with the exact prompt", () => {
    const b = band({ verification: UNLOGGED });
    expect(bandView(b, actionsOf(b), 120, "unicode", undefined)?.buttons).toEqual([
      {
        key: "log-evidence",
        hotkey: "1",
        label: "Log evidence",
        prompt: "Log evidence for `just test` with evidence_log",
      },
    ]);
  });

  test("a logged verification offers no button", () => {
    const b = band({ verification: LOGGED });
    expect(bandView(b, actionsOf(b), 120, "unicode", undefined)?.buttons).toEqual([]);
  });

  test("the button's label is cut on a row too narrow for it", () => {
    const b = band({ verification: UNLOGGED });
    expect(bandView(b, actionsOf(b), 12, "unicode", undefined)?.buttons.map((button) => button.label)).toEqual(["Log e…"]);
  });

  test("a long command's status row stops a space short of the engine's three-cell collapse mark", () => {
    const b = band({ verification: { ...UNLOGGED, command: "x".repeat(300) } });
    for (const columns of [70, 80, 120, 130]) expect(displayWidth(status(b, columns)), `at ${columns}`).toBe(columns - 4);
  });

  test("no row is ever wider than the room it has, at every width from 12 to 200", () => {
    const bands = [band({ verification: UNLOGGED }), band({ verification: LOGGED }), band({ verification: { ...UNLOGGED, command: "x".repeat(300) } }), band({ error: "e".repeat(300) })];
    for (let columns = 12; columns <= 200; columns++) {
      const width = usableColumns(columns);
      for (const b of bands) {
        const view = bandView(b, actionsOf(b), columns, "unicode", undefined);
        const buttons = view?.buttons ?? [];
        const buttonCells = buttons.reduce((sum, button) => sum + 3 + displayWidth(button.label), 0);
        expect(displayWidth(text(view?.status ?? [])), `status at ${columns}`).toBeLessThanOrEqual(columns - 4);
        expect(buttonCells + Math.max(0, buttons.length - 1) * BUTTON_GAP, `buttons at ${columns}`).toBeLessThanOrEqual(width);
      }
    }
  });

  test("an open run alone draws its line under no status row, and the warning keeps its own row whole beside it", () => {
    const quiet = bandView(band({}), nextActions({ verification: null, isRunOpen: true }), 120, "unicode", RUN);
    expect(quiet?.status).toEqual([]);
    expect(text(quiet?.run ?? [])).toBe("◆ dotman-rewrite ━━━━────────── 5/27 · ◐ #6 #7 · ⊗ 1");
    expect(quiet?.buttons.map((button) => `${button.hotkey}: ${button.label}`)).toEqual(["1: Task list"]);
    const b = band({ verification: UNLOGGED });
    const both = bandView(b, nextActions({ verification: b.verification, isRunOpen: true }), 40, "unicode", RUN);
    expect(text(both?.status ?? [])).toBe("! just test evidence not logged");
    expect(text(both?.run ?? [])).toBe("◆ dotman-rewrite 5/27 · ⊗ 1");
    expect(both?.buttons.map((button) => button.key)).toEqual(["log-evidence", "task-list"]);
  });

  test("the run line stops a space short of the collapse mark at every width from 12 to 200", () => {
    for (let columns = 12; columns <= 200; columns++) {
      expect(displayWidth(text(bandView(band({}), [], columns, "unicode", RUN)?.run ?? [])), `at ${columns}`).toBeLessThanOrEqual(columns - 4);
    }
  });
});
