import { describe, expect, test } from "bun:test";
import { arrange, type Band, bandView, BUTTON_GAP, oneLine, planTally, progressCells, share, type Span } from "./band-model.ts";
import { type NextAction, nextActions } from "./next-actions.ts";
import { displayWidth, glyphs, usableColumns } from "./ui-kit.ts";

const G = glyphs(false);
const PLAN = {
  name: "widget-rewrite",
  path: "/work/plans/widget-rewrite.md",
  done: 12,
  total: 46,
  next: { n: 13, title: "Port module 13" },
};
const PROOF = { proven: 52, unproven: 4, failed: 0 };
const UNLOGGED = { command: "just test", at: 1_790_000_000, isLogged: false };
const LOGGED = { ...UNLOGGED, isLogged: true };
const FULL: Band = {
  plan: { ...PLAN, done: 59, total: 68, next: { n: 43, title: "Record the final verification for the release" } },
  verification: UNLOGGED,
  proof: PROOF,
  error: null,
  readAt: 0,
};
const band = (fields: Partial<Band>): Band => ({ plan: null, verification: null, error: null, readAt: 0, ...fields });
const actionsOf = (b: Band): NextAction[] =>
  nextActions({ plan: b.plan, verification: b.verification, isAgentRunning: false, hasFinalVerification: false });
const text = (spans: readonly Span[]): string => spans.map((span) => span.text).join("");
const status = (b: Band, columns: number, g = G, running = 0): string =>
  text(bandView(b, actionsOf(b), columns, g, running)?.status ?? []);

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

describe("arrange", () => {
  const seg = (name: string, priority: number, min: number) => ({ name, priority, min });
  const names = (kept: readonly { name: string }[]) => kept.map((one) => one.name);

  test("keeps every segment that fits, in order", () => {
    expect(names(arrange([seg("a", 1, 5), seg("b", 3, 5), seg("c", 2, 5)], 21, 3))).toEqual(["a", "b", "c"]);
  });

  test("drops the largest priority number first, then the next, keeping the order of the rest", () => {
    const segments = [seg("a", 1, 5), seg("b", 3, 5), seg("c", 2, 5)];
    expect(names(arrange(segments, 20, 3))).toEqual(["a", "c"]);
    expect(names(arrange(segments, 12, 3))).toEqual(["a"]);
  });

  test("on a tie the later segment goes, and the last one stands whatever its size", () => {
    expect(names(arrange([seg("a", 2, 5), seg("b", 2, 5)], 9, 1))).toEqual(["a"]);
    expect(names(arrange([seg("a", 1, 50)], 10, 3))).toEqual(["a"]);
    expect(arrange([], 10, 3)).toEqual([]);
  });
});

describe("planTally", () => {
  test("counts the numbered tasks outside fences and names the first open one", () => {
    const text = [
      "# Plan",
      "- [x] 1. Done task",
      "```",
      "- [ ] 99. An example in a fence",
      "```",
      "- [ ] 2.   Port   the\tledger  ",
      "- [x] 3. Later done task",
      "- [ ] not numbered",
    ].join("\n");
    expect(planTally(text)).toEqual({ done: 2, total: 3, next: { n: 2, title: "Port the ledger" } });
  });

  test("a finished plan or one with no tasks has no next task", () => {
    expect(planTally("- [x] 1. a\n- [x] 2. b")).toEqual({ done: 2, total: 2, next: null });
    expect(planTally("# Empty")).toEqual({ done: 0, total: 0, next: null });
  });
});

test.each<[number, number, number]>([
  [0, 46, 0],
  [1, 46, 1],
  [12, 46, 1],
  [23, 46, 3],
  [45, 46, 4],
  [46, 46, 5],
  [0, 0, 0],
])("progressCells(%p, %p) fills %p of five", (done, total, cells) => {
  expect(progressCells(done, total)).toBe(cells);
});

describe("bandView", () => {
  test("draws nothing before the first snapshot", () => {
    expect(bandView(undefined, [], 120, G)).toBeUndefined();
  });

  test("draws nothing with no plan, no error and no action, even after a logged verification", () => {
    expect(bandView(band({ verification: LOGGED }), [], 120, G)).toBeUndefined();
  });

  test("a bound plan: a five-cell bar in the fill and track keys, the count, and the next task", () => {
    expect(bandView(band({ plan: PLAN }), [], 120, G)?.status).toEqual([
      { text: "▰", tone: "fill" },
      { text: "▱▱▱▱", tone: "track" },
      { text: " 12/46", tone: "muted" },
      { text: " · ", tone: "muted" },
      { text: "next ", tone: "muted" },
      { text: "13 ", tone: "title" },
      { text: "Port module 13", tone: "plain" },
    ]);
  });

  test("a finished plan fills the bar and names no next task", () => {
    expect(status(band({ plan: { ...PLAN, done: 46, next: null } }), 120)).toBe("▰▰▰▰▰ 46/46");
  });

  test("a bound plan with an unlogged verification", () => {
    expect(bandView(band({ plan: PLAN, verification: UNLOGGED }), [], 120, G)?.status.slice(7)).toEqual([
      { text: " · ", tone: "muted" },
      { text: "! ", tone: "warn" },
      { text: "just test", tone: "plain" },
      { text: " evidence not logged", tone: "warn" },
    ]);
  });

  test("a bound plan with a logged verification", () => {
    expect(bandView(band({ plan: PLAN, verification: LOGGED }), [], 120, G)?.status.slice(7)).toEqual([
      { text: " · ", tone: "muted" },
      { text: "✓ ", tone: "ok" },
      { text: "just test", tone: "plain" },
      { text: " evidence logged", tone: "muted" },
    ]);
  });

  test("proof counts are drawn only when the band carries them, a zero count muted", () => {
    expect(status(band({ plan: PLAN }), 120)).not.toContain("✓");
    expect(bandView(band({ plan: PLAN, proof: PROOF }), [], 120, G)?.status.slice(7)).toEqual([
      { text: " · ", tone: "muted" },
      { text: "✓52", tone: "ok" },
      { text: " ", tone: "muted" },
      { text: "!4", tone: "warn" },
      { text: " ", tone: "muted" },
      { text: "✗0", tone: "muted" },
    ]);
    expect(bandView(band({ plan: PLAN, proof: { proven: 0, unproven: 0, failed: 3 } }), [], 120, G)?.status.slice(8)).toEqual([
      { text: "✓0", tone: "muted" },
      { text: " ", tone: "muted" },
      { text: "!0", tone: "muted" },
      { text: " ", tone: "muted" },
      { text: "✗3", tone: "fail" },
    ]);
  });

  test("running agents are counted in the active tone, and none running draws nothing", () => {
    expect(bandView(band({ plan: PLAN }), [], 120, G, 2)?.status.slice(-2)).toEqual([
      { text: " · ", tone: "muted" },
      { text: "◆ 2 running", tone: "active" },
    ]);
    expect(status(band({ plan: PLAN }), 120)).not.toContain("running");
  });

  test("everything known, in the order of the design", () => {
    expect(status(FULL, 203, G, 2)).toBe(
      "▰▰▰▰▱ 59/68 · next 43 Record the final verification for the release · ✓52 !4 ✗0 · ! just test evidence not logged · ◆ 2 running",
    );
  });

  test("as the band narrows, segments drop by priority: verification, proof, next task, running agents", () => {
    const at = (columns: number) => status(FULL, columns, G, 2);
    expect(at(120)).toBe("▰▰▰▰▱ 59/68 · next 43 Record the final verification for… · ✓52 !4 ✗0 · ! just test evidence not logged · ◆ 2 running");
    expect(at(90)).toBe("▰▰▰▰▱ 59/68 · next 43 Record the fi… · ✓52 !4 ✗0 · ! just test not logged · ◆ 2 running");
    expect(at(80)).toBe("▰▰▰▰▱ 59/68 · next 43 Record the final verificatio… · ✓52 !4 ✗0 · ◆ 2 running");
    expect(at(60)).toBe("▰▰▰▰▱ 59/68 · next 43 Record the final ver… · ◆ 2 running");
    expect(at(50)).toBe("▰▰▰▰▱ 59/68 · ◆ 2 running");
    expect(at(20)).toBe("▰▰▰▰▱ 59/68");
  });

  test("no plan, with an unlogged verification that has an action", () => {
    const b = band({ verification: UNLOGGED });
    expect(status(b, 120)).toBe("no plan bound · ! just test evidence not logged");
    expect(status(b, 30)).toBe("no plan");
  });

  test("a read error is one line in the fail tone, whatever else is known", () => {
    const b = band({ plan: PLAN, verification: UNLOGGED, error: "Cannot read .omca/state/boulder.json:\nUnexpected token" });
    expect(bandView(b, [], 120, G, 2)?.status).toEqual([
      { text: "✗ Cannot read .omca/state/boulder.json: Unexpected token", tone: "fail" },
    ]);
  });

  test("ASCII glyphs replace every symbol", () => {
    const ascii = glyphs(true);
    expect(status(FULL, 203, ascii, 2)).toBe(
      "####- 59/68 - next 43 Record the final verification for the release - +52 !4 x0 - ! just test evidence not logged - @ 2 running",
    );
    expect(status(band({ plan: PLAN, verification: LOGGED }), 120, ascii)).toBe(
      "#---- 12/46 - next 13 Port module 13 - + just test evidence logged",
    );
    expect(status(band({ error: "boom" }), 120, ascii)).toBe("x boom");
  });

  test("a command or a title spanning lines or holding control characters reads as one line", () => {
    const b = band({
      plan: { ...PLAN, next: { n: 13, title: "Port\tmodule\n13" } },
      verification: { ...LOGGED, command: "just\ttest \\\n  --verbose\u001b[31m" },
    });
    expect(status(b, 120)).toBe("▰▱▱▱▱ 12/46 · next 13 Port module 13 · ✓ just test \\ --verbose [31m evidence logged");
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
      band({ plan: { ...PLAN, done: 1234, total: 5678, next: { n: 1235, title: "t".repeat(300) } }, verification: long, proof: { proven: 12345, unproven: 678, failed: 90 } }),
      band({ verification: UNLOGGED }),
      band({ error: "e".repeat(300) }),
      FULL,
    ];
    for (let columns = 12; columns <= 200; columns++) {
      const width = usableColumns(columns);
      for (const b of bands) {
        const view = bandView(b, actionsOf(b), columns, G, 3);
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
