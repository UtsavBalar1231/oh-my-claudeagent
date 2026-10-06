import { describe, expect, test } from "bun:test";
import { type Band, bandView, BUTTON_GAP, planTally, type Span } from "./band-model.ts";
import { type NextAction, nextActions } from "./next-actions.ts";
import { displayWidth, type GlyphTier, usableColumns } from "./ui-kit.ts";

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
const status = (b: Band, columns: number, tier: GlyphTier = "unicode", running = 0): string =>
  text(bandView(b, actionsOf(b), columns, tier, running)?.status ?? []);

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

  test("the next task's title is capped at 80 code points", () => {
    expect(planTally(`- [ ] 1. ${"w".repeat(100)}`).next?.title).toBe(`${"w".repeat(79)}…`);
  });

  test("a finished plan or one with no tasks has no next task", () => {
    expect(planTally("- [x] 1. a\n- [x] 2. b")).toEqual({ done: 2, total: 2, next: null });
    expect(planTally("# Empty")).toEqual({ done: 0, total: 0, next: null });
  });
});

describe("bandView", () => {
  test("draws nothing before the first snapshot", () => {
    expect(bandView(undefined, [], 120, "unicode")).toBeUndefined();
  });

  test("draws nothing with no plan, no error and no action, even after a logged verification", () => {
    expect(bandView(band({ verification: LOGGED }), [], 120, "unicode")).toBeUndefined();
  });

  test("a bound plan: the pane's five-cell bar in the fill and track keys, the count after a space, and the next task", () => {
    expect(bandView(band({ plan: PLAN }), [], 120, "unicode")?.status).toEqual([
      { text: "█", color: "success", tone: "plain" },
      { text: "▎", color: "success", backgroundColor: "subtle", tone: "plain" },
      { text: "███", color: "subtle", tone: "plain" },
      { text: " 12/46", tone: "muted" },
      { text: " · ", tone: "muted" },
      { text: "next ", tone: "muted" },
      { text: "13 ", tone: "title" },
      { text: "Port module 13", tone: "plain" },
    ]);
  });

  test("a finished plan fills the bar and names no next task", () => {
    expect(status(band({ plan: { ...PLAN, done: 46, next: null } }), 120)).toBe("█████ 46/46");
  });

  test("a bound plan with an unlogged verification", () => {
    expect(bandView(band({ plan: PLAN, verification: UNLOGGED }), [], 120, "unicode")?.status.slice(8)).toEqual([
      { text: " · ", tone: "muted" },
      { text: "! ", tone: "warn" },
      { text: "just test", tone: "plain" },
      { text: " evidence not logged", tone: "plain" },
    ]);
  });

  test("a bound plan with a logged verification", () => {
    expect(bandView(band({ plan: PLAN, verification: LOGGED }), [], 120, "unicode")?.status.slice(8)).toEqual([
      { text: " · ", tone: "muted" },
      { text: "✓ ", tone: "ok" },
      { text: "just test", tone: "plain" },
      { text: " evidence logged", tone: "muted" },
    ]);
  });

  test("proof counts are drawn only when the band carries them and only where they are not zero: the glyph in its tone, then the count and its word plain", () => {
    expect(status(band({ plan: PLAN }), 120)).not.toContain("✓");
    expect(bandView(band({ plan: PLAN, proof: PROOF }), [], 120, "unicode")?.status.slice(8)).toEqual([
      { text: " · ", tone: "muted" },
      { text: "✓ ", tone: "ok" },
      { text: "52 proven", tone: "plain" },
      { text: "  ", tone: "muted" },
      { text: "! ", tone: "warn" },
      { text: "4 unproven", tone: "plain" },
    ]);
    expect(bandView(band({ plan: PLAN, proof: { proven: 0, unproven: 0, failed: 3 } }), [], 120, "unicode")?.status.slice(9)).toEqual([
      { text: "✗ ", tone: "fail" },
      { text: "3 failed", tone: "plain" },
    ]);
    expect(status(band({ plan: PLAN, proof: { proven: 0, unproven: 0, failed: 0 } }), 120)).toBe("█▎███ 12/46 · next 13 Port module 13");
  });

  test("running agents: the glyph in the active tone, the words plain; none running draws nothing", () => {
    expect(bandView(band({ plan: PLAN }), [], 120, "unicode", 2)?.status.slice(-3)).toEqual([
      { text: " · ", tone: "muted" },
      { text: "◆ ", tone: "active" },
      { text: "2 running", tone: "plain" },
    ]);
    expect(status(band({ plan: PLAN }), 120)).not.toContain("running");
  });

  test("running agents with no plan bound: the band shows `N running` and not the no-plan text", () => {
    expect(status(band({}), 120, "unicode", 2)).toBe("◆ 2 running");
    expect(status(band({ verification: LOGGED }), 120, "unicode", 2)).not.toContain("no plan");
    expect(status(band({}), 120, "unicode", 2)).not.toContain("no plan");
  });

  test("everything known, in the order of the design", () => {
    expect(status(FULL, 203, "unicode", 2)).toBe(
      "████▍ 59/68 · next 43 Record the final verification for the release · ✓ 52 proven  ! 4 unproven · ! just test evidence not logged · ◆ 2 running",
    );
  });

  test("as the band narrows, segments drop by priority: verification, proof, next task, running agents", () => {
    const at = (columns: number) => status(FULL, columns, "unicode", 2);
    expect(at(120)).toBe("████▍ 59/68 · next 43 Record the final… · ✓ 52 proven  ! 4 unproven · ! just test evidence not logged · ◆ 2 running");
    expect(at(112)).toBe("████▍ 59/68 · next 43 Record the final verification for… · ✓ 52  ! 4 · ! just test not logged · ◆ 2 running");
    expect(at(80)).toBe("████▍ 59/68 · next 43 Record the final verificati… · ✓ 52  ! 4 · ◆ 2 running");
    expect(at(60)).toBe("████▍ 59/68 · next 43 Record the final ve… · ◆ 2 running");
    expect(at(50)).toBe("████▍ 59/68 · ◆ 2 running");
    expect(at(20)).toBe("████▍ 59/68");
  });

  test("no plan, with an unlogged verification that has an action", () => {
    const b = band({ verification: UNLOGGED });
    expect(status(b, 120)).toBe("no plan bound · ! just test evidence not logged");
    expect(status(b, 30)).toBe("no plan");
  });

  test("a read error is one line, its glyph in the fail tone, whatever else is known", () => {
    const b = band({ plan: PLAN, verification: UNLOGGED, error: "Cannot read .omca/state/boulder.json:\nUnexpected token" });
    expect(bandView(b, [], 120, "unicode", 2)?.status).toEqual([
      { text: "✗ ", tone: "fail" },
      { text: "Cannot read .omca/state/boulder.json: Unexpected token", tone: "plain" },
    ]);
  });

  test("ASCII glyphs replace every symbol", () => {
    expect(status(FULL, 203, "ascii", 2)).toBe(
      "[##.] 59/68 - next 43 Record the final verification for the release - + 52 proven  ! 4 unproven - ! just test evidence not logged - @ 2 running",
    );
    expect(status(band({ plan: PLAN, verification: LOGGED }), 120, "ascii")).toBe(
      "[#..] 12/46 - next 13 Port module 13 - + just test evidence logged",
    );
    expect(status(band({ error: "boom" }), 120, "ascii")).toBe("x boom");
  });

  test("a command or a title spanning lines or holding control characters reads as one line", () => {
    const b = band({
      plan: { ...PLAN, next: { n: 13, title: "Port\tmodule\n13" } },
      verification: { ...LOGGED, command: "just\ttest \\\n  --verbose\u001b[31m" },
    });
    expect(status(b, 120)).toBe("█▎███ 12/46 · next 13 Port module 13 · ✓ just test \\ --verbose [31m evidence logged");
  });

  test("hotkeys number the actions in priority order and fill with the exact prompt", () => {
    const b = band({ plan: PLAN, verification: UNLOGGED });
    expect(bandView(b, actionsOf(b), 120, "unicode")?.buttons).toEqual([
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
    expect(bandView(b, actionsOf(b), 20, "unicode")?.buttons.map((button) => button.label)).toEqual(["Log…", "Sta…"]);
  });

  test("a full status row stops a space short of the engine's three-cell collapse mark", () => {
    for (const columns of [60, 80, 130, 140]) expect(displayWidth(status(FULL, columns, "unicode", 2)), `at ${columns}`).toBe(columns - 4);
  });

  test("no row is ever wider than the room it has, at every width from 12 to 200", () => {
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
        const view = bandView(b, actionsOf(b), columns, "unicode", 3);
        const buttons = view?.buttons ?? [];
        const buttonCells = buttons.reduce((sum, button) => sum + 3 + displayWidth(button.label), 0);
        expect(displayWidth(text(view?.status ?? [])), `status at ${columns}`).toBeLessThanOrEqual(columns - 4);
        expect(buttonCells + Math.max(0, buttons.length - 1) * BUTTON_GAP, `buttons at ${columns}`).toBeLessThanOrEqual(width);
      }
    }
  });
});
