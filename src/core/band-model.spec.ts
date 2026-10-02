import { describe, expect, test } from "bun:test";
import { type Band, bandView, BUTTON_GAP, oneLine, share, type Span } from "./band-model.ts";
import { type NextAction, nextActions } from "./next-actions.ts";
import { displayWidth, glyphs, usableColumns } from "./ui-kit.ts";

const G = glyphs(false);
const PLAN = { name: "widget-rewrite", path: "/work/plans/widget-rewrite.md", done: 12, total: 46 };
const UNLOGGED = { command: "just test", at: 1_790_000_000, isLogged: false };
const LOGGED = { ...UNLOGGED, isLogged: true };
const band = (fields: Partial<Band>): Band => ({ plan: null, verification: null, error: null, readAt: 0, ...fields });
const actionsOf = (b: Band): NextAction[] =>
  nextActions({ plan: b.plan, verification: b.verification, isAgentRunning: false, hasFinalVerification: false });
const text = (spans: readonly Span[]): string => spans.map((span) => span.text).join("");
const status = (b: Band, columns: number, g = G): string => text(bandView(b, actionsOf(b), columns, g)?.status ?? []);

describe("share", () => {
  test.each<[number[], number, number[]]>([
    [[10, 20], 100, [10, 20]],
    [[10, 20], 30, [10, 20]],
    [[10, 20], 20, [10, 10]],
    [[30, 4], 20, [16, 4]],
    [[30, 40], 21, [10, 11]],
    [[5, 5, 50], 30, [5, 5, 20]],
    [[10, 20], 0, [0, 0]],
    [[10, 20], -5, [0, 0]],
    [[], 10, []],
  ])("share(%p, %p) is %p", (wants, room, expected) => {
    expect(share(wants, room)).toEqual(expected);
  });
});

describe("bandView", () => {
  test("draws nothing before the first snapshot", () => {
    expect(bandView(undefined, [], 120, G)).toBeUndefined();
  });

  test("draws nothing with no plan, no error and no action, even after a logged verification", () => {
    expect(bandView(band({ verification: LOGGED }), [], 120, G)).toBeUndefined();
  });

  test("a bound plan with no verification", () => {
    expect(bandView(band({ plan: PLAN }), [], 120, G)?.status).toEqual([
      { text: "widget-rewrite", tone: "title" },
      { text: " 12/46 tasks", tone: "muted" },
      { text: " · ", tone: "muted" },
      { text: "no verification yet", tone: "muted" },
    ]);
  });

  test("a bound plan with an unlogged verification", () => {
    expect(bandView(band({ plan: PLAN, verification: UNLOGGED }), [], 120, G)?.status).toEqual([
      { text: "widget-rewrite", tone: "title" },
      { text: " 12/46 tasks", tone: "muted" },
      { text: " · ", tone: "muted" },
      { text: "! ", tone: "warn" },
      { text: "just test", tone: "plain" },
      { text: " evidence not logged", tone: "warn" },
    ]);
  });

  test("a bound plan with a logged verification", () => {
    expect(bandView(band({ plan: PLAN, verification: LOGGED }), [], 120, G)?.status).toEqual([
      { text: "widget-rewrite", tone: "title" },
      { text: " 12/46 tasks", tone: "muted" },
      { text: " · ", tone: "muted" },
      { text: "✓ ", tone: "ok" },
      { text: "just test", tone: "plain" },
      { text: " evidence logged", tone: "muted" },
    ]);
  });

  test("no plan, with an unlogged verification that has an action", () => {
    const b = band({ verification: UNLOGGED });
    expect(status(b, 120)).toBe("no plan bound · ! just test evidence not logged");
  });

  test("a read error is one line in the fail tone, whatever else is known", () => {
    const b = band({ plan: PLAN, verification: UNLOGGED, error: "Cannot read .omca/state/boulder.json:\nUnexpected token" });
    expect(bandView(b, [], 120, G)?.status).toEqual([
      { text: "✗ Cannot read .omca/state/boulder.json: Unexpected token", tone: "fail" },
    ]);
  });

  test("ASCII glyphs replace every symbol", () => {
    const ascii = glyphs(true);
    expect(status(band({ plan: PLAN, verification: LOGGED }), 120, ascii)).toBe(
      "widget-rewrite 12/46 tasks - + just test evidence logged",
    );
    expect(status(band({ plan: PLAN, verification: UNLOGGED }), 120, ascii)).toBe(
      "widget-rewrite 12/46 tasks - ! just test evidence not logged",
    );
    expect(status(band({ error: "boom" }), 120, ascii)).toBe("x boom");
  });

  test("a command spanning lines or holding control characters reads as one line", () => {
    const b = band({ plan: PLAN, verification: { ...LOGGED, command: "just\ttest \\\n  --verbose\u001b[31m" } });
    expect(status(b, 120)).toBe("widget-rewrite 12/46 tasks · ✓ just test \\ --verbose [31m evidence logged");
  });

  test("long names truncate from the end, sharing the row, at 80 columns", () => {
    const b = band({
      plan: { ...PLAN, name: "omca-v3-typescript-mods-rewrite-with-a-long-name" },
      verification: { ...UNLOGGED, command: "bun test src servers statusline scripts opencode" },
    });
    expect(status(b, 80)).toBe("omca-v3-typescript-… 12/46 tasks · ! bun test src server… evidence not logged");
  });

  test("a narrow band drops to the compact words before it cuts names", () => {
    expect(status(band({ plan: PLAN, verification: UNLOGGED }), 40)).toBe("widget-… 12/46 · ! just t… not logged");
    expect(status(band({ plan: PLAN, verification: LOGGED }), 40)).toBe("widget-re… 12/46 · ✓ just test logged");
    expect(status(band({ plan: PLAN }), 40)).toBe("widget-rewrite 12/46 · unverified");
  });

  test("hotkeys number the actions in priority order and fill with the exact prompt", () => {
    const b = band({ plan: PLAN, verification: UNLOGGED });
    expect(bandView(b, actionsOf(b), 120, G)?.buttons).toEqual([
      {
        key: "log-evidence",
        hotkey: "1",
        label: "Log evidence",
        prompt: "Log evidence for `just test` with evidence_log",
      },
      {
        key: "start-work",
        hotkey: "2",
        label: "Start work",
        prompt: "/oh-my-claudeagent:start-work /work/plans/widget-rewrite.md",
      },
    ]);
  });

  test("button labels share a row too narrow for both", () => {
    const b = band({ plan: PLAN, verification: UNLOGGED });
    expect(bandView(b, actionsOf(b), 20, G)?.buttons.map((button) => button.label)).toEqual(["Log…", "Sta…"]);
  });

  test("no row is ever wider than the usable columns, at every width from 12 to 200", () => {
    const long = { ...UNLOGGED, command: "x".repeat(300) };
    const bands = [
      band({ plan: PLAN }),
      band({ plan: PLAN, verification: UNLOGGED }),
      band({ plan: PLAN, verification: LOGGED }),
      band({ plan: { ...PLAN, name: "n".repeat(300), done: 1234, total: 5678 }, verification: long }),
      band({ verification: UNLOGGED }),
      band({ error: "e".repeat(300) }),
    ];
    for (let columns = 12; columns <= 200; columns++) {
      const width = usableColumns(columns);
      for (const b of bands) {
        const view = bandView(b, actionsOf(b), columns, G);
        const buttons = view?.buttons ?? [];
        const buttonCells = buttons.reduce((sum, button) => sum + 3 + displayWidth(button.label), 0);
        expect(displayWidth(text(view?.status ?? [])), `status at ${columns}`).toBeLessThanOrEqual(width);
        expect(buttonCells + Math.max(0, buttons.length - 1) * BUTTON_GAP, `buttons at ${columns}`).toBeLessThanOrEqual(width);
      }
    }
  });
});

test("oneLine folds whitespace and control characters into single spaces", () => {
  expect(oneLine("  a\n\tb\u0007c  ")).toBe("a b c");
});
