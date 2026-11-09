import { describe, expect, test } from "bun:test";
import { type Band, bandView, BUTTON_GAP } from "./band-model.ts";
import { type NextAction, nextActions } from "./next-actions.ts";
import type { RunSummary } from "./run-line.ts";
import { displayWidth, type GlyphTier, usableColumns } from "./ui-kit.ts";

const band = (fields: Partial<Band>): Band => ({ error: null, readAt: 0, ...fields });
const actionsOf = (isRunOpen: boolean): NextAction[] => nextActions({ isRunOpen });
const RUN: RunSummary = { name: "dotman-rewrite", done: 5, total: 27, running: ["6", "7"], blocked: ["8"], isOpen: true };
const text = (spans: readonly { text: string }[]): string => spans.map((span) => span.text).join("");
const status = (b: Band, columns: number, tier: GlyphTier = "unicode"): string => text(bandView(b, [], columns, tier, undefined)?.status ?? []);

describe("bandView", () => {
  test("draws nothing before the first snapshot", () => {
    expect(bandView(undefined, [], 120, "unicode", undefined)).toBeUndefined();
  });

  test("draws nothing with no error, no action and no run", () => {
    expect(bandView(band({}), [], 120, "unicode", undefined)).toBeUndefined();
  });

  test("a read error is one line, its glyph in the fail tone", () => {
    const b = band({ error: "Cannot read the session status file:\nUnexpected token" });
    expect(bandView(b, [], 120, "unicode", undefined)?.status).toEqual([
      { text: "✗ ", tone: "fail" },
      { text: "Cannot read the session status file: Unexpected token", tone: "plain" },
    ]);
  });

  test("ASCII glyphs replace every symbol", () => {
    expect(status(band({ error: "boom" }), 120, "ascii")).toBe("x boom");
  });

  test("the task list action takes the first hotkey and fills with the exact prompt", () => {
    expect(bandView(band({}), actionsOf(true), 120, "unicode", RUN)?.buttons).toEqual([{ key: "task-list", hotkey: "1", label: "Task list", prompt: "/tasklist" }]);
  });

  test("the button's label is cut on a row too narrow for it", () => {
    expect(bandView(band({}), actionsOf(true), 8, "unicode", RUN)?.buttons.map((button) => button.label)).toEqual(["T…"]);
  });

  test("a long error's status row stops a space short of the engine's three-cell collapse mark", () => {
    const b = band({ error: "x".repeat(300) });
    for (const columns of [70, 80, 120, 130]) expect(displayWidth(status(b, columns)), `at ${columns}`).toBe(columns - 4);
  });

  test("no row is ever wider than the room it has, at every width from 12 to 200", () => {
    const b = band({ error: "e".repeat(300) });
    for (let columns = 12; columns <= 200; columns++) {
      const width = usableColumns(columns);
      const view = bandView(b, actionsOf(true), columns, "unicode", RUN);
      const buttons = view?.buttons ?? [];
      const buttonCells = buttons.reduce((sum, button) => sum + 3 + displayWidth(button.label), 0);
      expect(displayWidth(text(view?.status ?? [])), `status at ${columns}`).toBeLessThanOrEqual(columns - 4);
      expect(buttonCells + Math.max(0, buttons.length - 1) * BUTTON_GAP, `buttons at ${columns}`).toBeLessThanOrEqual(width);
    }
  });

  test("an open run alone draws its line under no status row, and an error keeps its own row whole beside it", () => {
    const quiet = bandView(band({}), actionsOf(true), 120, "unicode", RUN);
    expect(quiet?.status).toEqual([]);
    expect(text(quiet?.run ?? [])).toBe("◆ dotman-rewrite ━━━━────────── 5/27 · ◐ #6 #7 · ⊗ 1");
    expect(quiet?.buttons.map((button) => `${button.hotkey}: ${button.label}`)).toEqual(["1: Task list"]);
    const both = bandView(band({ error: "boom" }), actionsOf(true), 40, "unicode", RUN);
    expect(text(both?.status ?? [])).toBe("✗ boom");
    expect(text(both?.run ?? [])).toBe("◆ dotman-rewrite 5/27 · ⊗ 1");
    expect(both?.buttons.map((button) => button.key)).toEqual(["task-list"]);
  });

  test("the run line stops a space short of the collapse mark at every width from 12 to 200", () => {
    for (let columns = 12; columns <= 200; columns++) {
      expect(displayWidth(text(bandView(band({}), [], columns, "unicode", RUN)?.run ?? [])), `at ${columns}`).toBeLessThanOrEqual(columns - 4);
    }
  });
});
