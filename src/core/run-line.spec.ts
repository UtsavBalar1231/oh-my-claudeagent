import { describe, expect, test } from "bun:test";
import type { NativeTask } from "./native-tasks.ts";
import { bandRunLine, changeRow, hasChanges, runSummary, type TaskChanges, taskChanges } from "./run-line.ts";
import { displayWidth, glyphs } from "./ui-kit.ts";
import { type Piece, TONE_KEYS } from "./visual.ts";

const U = glyphs("unicode");
const A = glyphs("ascii");
const N = glyphs("nerd");
const RUN = "dotman-rewrite";

const task = (id: number, fields: Partial<NativeTask> = {}): NativeTask => ({
  id: String(id),
  subject: `Task ${id}`,
  description: "",
  activeForm: "",
  status: "pending",
  owner: "",
  blocks: [],
  blockedBy: [],
  run: RUN,
  isFinal: false,
  blockedReason: "",
  details: [],
  ...fields,
});

// The seeded run: 1-5 done, 6 and 7 running, 8 closed as blocked, 9-26 pending, 27 final.
const seeded = (): NativeTask[] =>
  Array.from({ length: 27 }, (_, index) => {
    const id = index + 1;
    if (id <= 5) return task(id, { status: "completed" });
    if (id === 6 || id === 7) return task(id, { status: "in_progress" });
    if (id === 8) return task(id, { status: "in_progress", blockedReason: "git 2.25 has no --porcelain=v2" });
    return task(id, { isFinal: id === 27 });
  });

const text = (pieces: readonly Piece[]) => pieces.map((piece) => piece.text).join("");
const NONE: TaskChanges = { created: 0, completed: [], started: [], blocked: [], isFinalDone: false };

describe("runSummary", () => {
  test("counts done, running and closed as blocked over every task of the run", () => {
    expect(runSummary(seeded())).toEqual({ name: RUN, done: 5, total: 27, running: ["6", "7"], blocked: ["8"], isOpen: true });
  });

  test("a list with no run has no summary, and a run with nothing left to do is not open", () => {
    expect(runSummary([task(1, { run: "" })])).toBeUndefined();
    expect(runSummary([task(1, { status: "completed" }), task(2, { status: "completed", isFinal: true })])?.isOpen).toBe(false);
  });
});

describe("taskChanges", () => {
  test("an empty list before: every task is created, and one already running is started too", () => {
    const after = [task(1, { status: "in_progress" }), task(2), task(3, { run: "other" })];
    expect(taskChanges([], after, RUN)).toEqual({ ...NONE, created: 2, started: ["1"] });
  });

  test("completed, started and closed as blocked are read from the state change, and a task left as it was is not named", () => {
    const before = seeded();
    const after = before.map((one) => {
      if (one.id === "6") return { ...one, status: "completed" as const };
      if (one.id === "9") return { ...one, status: "in_progress" as const };
      if (one.id === "10") return { ...one, status: "in_progress" as const, blockedReason: "needs a decision" };
      return one;
    });
    expect(taskChanges(before, after, RUN)).toEqual({ ...NONE, completed: ["6"], started: ["9"], blocked: ["10"] });
  });

  test("the final task completed is its own change and not in the completed ids", () => {
    const before = [task(1, { status: "completed" }), task(2, { isFinal: true })];
    const after = [before[0] ?? task(1), task(2, { isFinal: true, status: "completed" })];
    expect(taskChanges(before, after, RUN)).toEqual({ ...NONE, isFinalDone: true });
  });

  test("the same list twice has no change", () => {
    expect(hasChanges(taskChanges(seeded(), seeded(), RUN))).toBe(false);
    expect(hasChanges({ ...NONE, isFinalDone: true })).toBe(true);
  });
});

describe("changeRow", () => {
  const summary = { name: RUN, done: 5, total: 27, running: ["6", "7"], blocked: ["8"], isOpen: true };
  const changes: TaskChanges = { created: 26, completed: ["5"], started: ["6", "7"], blocked: ["8"], isFinalDone: false };

  test("reads the run, done of total, each change with its mark, then the hint", () => {
    expect(text(changeRow(summary, changes, U, 200))).toBe("◆ dotman-rewrite  5/27 · +26 tasks · ✓ #5 · ◐ #6 #7 · ⊗ #8 blocked · /tasklist");
  });

  test("each mark draws in its tone, the run name bold and the rest muted", () => {
    const pieces = changeRow(summary, changes, U, 200);
    const colorOf = (piece: string) => pieces.find((one) => one.text === piece)?.color;
    expect(colorOf("◆ ")).toBe(TONE_KEYS.plan);
    expect(colorOf("✓ ")).toBe(TONE_KEYS.ok);
    expect(colorOf("◐ ")).toBe(TONE_KEYS.active);
    expect(colorOf("⊗ ")).toBe(TONE_KEYS.fail);
    expect(colorOf("/tasklist")).toBe(TONE_KEYS.muted);
    expect(pieces.find((one) => one.text === RUN)?.bold).toBe(true);
  });

  test("parts leave whole from the end as the row narrows, never cutting the name or an id", () => {
    expect(text(changeRow(summary, changes, U, 77))).toBe("◆ dotman-rewrite  5/27 · +26 tasks · ✓ #5 · ◐ #6 #7 · ⊗ #8 blocked");
    expect(text(changeRow(summary, changes, U, 60))).toBe("◆ dotman-rewrite  5/27 · +26 tasks · ✓ #5 · ◐ #6 #7");
    expect(text(changeRow(summary, changes, U, 40))).toBe("◆ dotman-rewrite  5/27 · +26 tasks");
    expect(text(changeRow(summary, changes, U, 30))).toBe("◆ dotman-rewrite  5/27");
  });

  test("a name too long for the row alone is cut to the width as a last resort", () => {
    const row = changeRow({ ...summary, name: "x".repeat(60) }, changes, U, 40);
    expect(displayWidth(text(row))).toBeLessThanOrEqual(40);
    expect(text(row)).toEndWith("…");
  });

  test("ids list three, then how many more", () => {
    const many = { ...NONE, completed: ["1", "2", "3", "4", "5"] };
    expect(text(changeRow(summary, many, U, 200))).toBe("◆ dotman-rewrite  5/27 · ✓ #1 #2 #3 +2 · /tasklist");
  });

  test("one task created reads as one task, and the final task done reads as final done", () => {
    expect(text(changeRow(summary, { ...NONE, created: 1 }, U, 200))).toBe("◆ dotman-rewrite  5/27 · +1 task · /tasklist");
    expect(text(changeRow({ ...summary, done: 27 }, { ...NONE, completed: ["26"], isFinalDone: true }, U, 200))).toBe("◆ dotman-rewrite  27/27 · ✓ #26 · ◆ final done · /tasklist");
  });

  test("the ASCII and Nerd Font tiers draw their own marks", () => {
    expect(text(changeRow(summary, changes, A, 200))).toBe("= dotman-rewrite  5/27 - +26 tasks - + #5 - ~ #6 #7 - % #8 blocked - /tasklist");
    expect(text(changeRow(summary, { ...changes, isFinalDone: true }, N, 200))).toBe(
      "\u{f11e} dotman-rewrite  5/27 · +26 tasks · \u{f058} #5 · \u{f042} #6 #7 · \u{f05e} #8 blocked · \u{f11e} final done · /tasklist",
    );
  });
});

describe("bandRunLine", () => {
  const summary = runSummary(seeded());
  if (summary === undefined) throw new Error("the seeded list has a run");

  test("reads the run, a bar, done of total, the running ids and the blocked count", () => {
    expect(text(bandRunLine(summary, U, 116))).toBe("◆ dotman-rewrite ━━━━────────── 5/27 · ◐ #6 #7 · ⊗ 1");
  });

  test("the bar draws done, running and the rest in their tones", () => {
    const bar = bandRunLine(summary, U, 116).filter((piece) => /^[━─]+$/.test(piece.text));
    expect(bar).toEqual([
      { text: "━━━", color: TONE_KEYS.ok },
      { text: "━", color: TONE_KEYS.active },
      { text: "──────────", color: TONE_KEYS.muted },
    ]);
  });

  test("as the band narrows the bar leaves, then the running ids, then the blocked count", () => {
    expect(text(bandRunLine(summary, U, 40))).toBe("◆ dotman-rewrite 5/27 · ◐ #6 #7 · ⊗ 1");
    expect(text(bandRunLine(summary, U, 30))).toBe("◆ dotman-rewrite 5/27 · ⊗ 1");
    expect(text(bandRunLine(summary, U, 22))).toBe("◆ dotman-rewrite 5/27");
    expect(displayWidth(text(bandRunLine(summary, U, 12)))).toBeLessThanOrEqual(12);
  });

  test("no running task and nothing blocked leaves the bar and the count", () => {
    const quiet = { ...summary, running: [], blocked: [] };
    expect(text(bandRunLine(quiet, U, 116))).toBe("◆ dotman-rewrite ━━━─────────── 5/27");
  });

  test("the ASCII and Nerd Font tiers draw their own marks and bar", () => {
    expect(text(bandRunLine(summary, A, 116))).toBe("= dotman-rewrite ====---------- 5/27 - ~ #6 #7 - % 1");
    expect(text(bandRunLine(summary, N, 116))).toBe("\u{f11e} dotman-rewrite ━━━━────────── 5/27 · \u{f042} #6 #7 · \u{f05e} 1");
  });
});
