import { describe, expect, test } from "bun:test";
import { isReceiptId, type PlanComplete, type Receipt, receiptId, receiptRows, settled, type TaskReceipt, taskReceipt } from "./plan-receipts.ts";
import type { Verdict } from "./proof.ts";
import { displayWidth, glyphs } from "./ui-kit.ts";
import { piecesWidth } from "./visual.ts";

const g = glyphs("unicode");
const task = (n: number, overrides: Partial<TaskReceipt> = {}): TaskReceipt => ({ n, title: `Port module ${n}`, proof: "proven", command: "just test", ...overrides });
const receipt = (overrides: Partial<Receipt> = {}): Receipt => ({ id: "receipt-1", plan: "widget", path: "/p", total: 14, tasks: [task(7)], complete: null, ...overrides });
const text = (pieces: readonly { text: string }[]): string => pieces.map((piece) => piece.text).join("");
const run = (exitCode: number, command = "just test") => ({ type: "test" as const, command, exitCode, at: 2, snippet: "", verifiedBy: null, planSha: "", tree: "" });
const verdict = (proof: Verdict["proof"], since: Verdict["since"] = []): Verdict => ({ proof, changedAt: 1, since, lastPass: undefined });

describe("receipt ids", () => {
  test("stay inside the engine's id alphabet and length, and name themselves", () => {
    const id = receiptId(Date.UTC(2026, 9, 2), 12_345);
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(isReceiptId(id)).toBe(true);
    expect(isReceiptId("build")).toBe(false);
  });
});

describe("taskReceipt", () => {
  test("names the newest run that gave a pass or a failure, and none for unproven or no verdict", () => {
    expect(taskReceipt({ n: 1, title: "A" }, verdict("proven", [run(0, "bun test")]))).toEqual({ n: 1, title: "A", proof: "proven", command: "bun test" });
    expect(taskReceipt({ n: 1, title: "A" }, verdict("failed", [run(1, "just ci")]))).toEqual({ n: 1, title: "A", proof: "failed", command: "just ci" });
    expect(taskReceipt({ n: 1, title: "A" }, verdict("unproven"))).toEqual({ n: 1, title: "A", proof: "unproven", command: null });
    expect(taskReceipt({ n: 1, title: "A" }, undefined)).toEqual({ n: 1, title: "A", proof: null, command: null });
  });
});

describe("settled", () => {
  const now = (proof: TaskReceipt["proof"], command: string | null = null) => new Map([[7, task(7, { title: "Renamed", proof, command })]]);
  const stored = (proof: TaskReceipt["proof"], command: string | null = null) => receipt({ tasks: [task(7, { proof, command })] });
  const after = (from: TaskReceipt["proof"], to: TaskReceipt["proof"]) => settled(stored(from), now(to, "bun test"), null).tasks[0]?.proof;

  test.each([
    [null, "proven", "proven"],
    [null, "failed", "failed"],
    [null, "unproven", null],
    ["unproven", "proven", "proven"],
    ["unproven", "failed", "failed"],
    ["failed", "proven", "proven"],
    ["failed", "unproven", "failed"],
    ["proven", "unproven", "proven"],
    ["proven", "failed", "proven"],
  ] as const)("a row that said %s and now reads %s says %s", (from, to, says) => {
    expect(after(from, to)).toBe(says);
  });

  test("takes the command that gave the new verdict and keeps the title the row was placed with", () => {
    expect(settled(stored("unproven"), now("failed", "bun test"), null).tasks).toEqual([task(7, { proof: "failed", command: "bun test" })]);
  });

  test("a proven row keeps the command that proved it", () => {
    expect(settled(stored("proven", "just test"), now("proven", "bun test"), null).tasks[0]?.command).toBe("just test");
  });

  test("keeps what a task no longer on the plan said, and a plan's outcome once it reopens", () => {
    const complete: PlanComplete = { proven: 1, unproven: 0, failed: 0, isVerified: true };
    const placed = receipt({ complete });
    const later = settled(placed, new Map(), null);
    expect(later.tasks).toEqual(placed.tasks);
    expect(later.complete).toEqual(complete);
  });

  test("gives a row that did not end the plan no outcome when a later row does", () => {
    expect(settled(receipt(), new Map(), { proven: 1, unproven: 0, failed: 0, isVerified: false }).complete).toBeNull();
  });

  test("a plan's outcome moves to passed and to more proof, and never back", () => {
    const outcome = (proven: number, isVerified: boolean): PlanComplete => ({ proven, unproven: 3 - proven, failed: 0, isVerified });
    const from = (before: PlanComplete, current: PlanComplete) => settled(receipt({ complete: before }), new Map(), current).complete;
    expect(from(outcome(1, false), outcome(1, true))).toEqual(outcome(1, true));
    expect(from(outcome(1, false), outcome(3, false))).toEqual(outcome(3, false));
    expect(from(outcome(3, false), outcome(1, false))).toEqual(outcome(3, false));
    expect(from(outcome(3, true), outcome(1, false))).toEqual(outcome(3, true));
  });
});

describe("receiptRows", () => {
  test("words each verdict, and a task with no verdict is just done", () => {
    const rows = receiptRows(receipt({ tasks: [task(1), task(2, { proof: "unproven", command: null }), task(3, { proof: "failed", command: "bun test" }), task(4, { proof: null, command: null })] }), g, 120);
    expect(rows.map(text)).toEqual([
      "✓ Task 1 Port module 1 · proven by just test",
      "! Task 2 Port module 2 · unproven",
      "✗ Task 3 Port module 3 · failed bun test",
      "✓ Task 4 Port module 4",
    ]);
  });

  test("folds tasks past the limit into a count", () => {
    const rows = receiptRows(receipt({ tasks: Array.from({ length: 9 }, (_, i) => task(i + 1)) }), g, 120).map(text);
    expect(rows).toHaveLength(7);
    expect(rows[6]).toBe("+3 more tasks");
    expect(receiptRows(receipt({ tasks: Array.from({ length: 7 }, (_, i) => task(i + 1)) }), g, 120).map(text)[6]).toBe("+1 more task");
  });

  test("cuts the title first and keeps a short command whole", () => {
    const [row] = receiptRows(receipt({ tasks: [task(7, { title: "A very long task title that cannot fit beside its proof in this row" })] }), g, 60);
    expect(text(row ?? [])).toBe("✓ Task 7 A very long task title that… · proven by just test");
    expect(piecesWidth(row ?? [])).toBeLessThanOrEqual(60);
  });

  test("drops a title too short to read, and cuts a long command last", () => {
    const long = "bun test src servers statusline scripts opencode";
    const row = (columns: number) => text(receiptRows(receipt({ tasks: [task(7, { command: long })] }), g, columns)[0] ?? []);
    expect(row(34)).toBe("✓ Task 7 Por… · proven by bun tes…");
    expect(row(33)).toBe("✓ Task 7 · proven by bun test sr…");
  });

  test("a plan's outcome gives up its counts, then its tally, and keeps what the verification says", () => {
    const complete = { proven: 12, unproven: 2, failed: 0, isVerified: false };
    const outcome = (columns: number) => text(receiptRows(receipt({ tasks: [], complete }), g, columns)[0] ?? []);
    expect(outcome(120)).toBe("! Plan widget complete · 14/14 · ✓ 12 proven ! 2 unproven · final verification not logged");
    expect(outcome(80)).toBe("! Plan widget complete · 14/14 · final verification not logged");
    expect(outcome(56)).toBe("! Plan widget complete · final verification not logged");
    expect(displayWidth(outcome(40))).toBeLessThanOrEqual(40);
  });

  test("every row fits at every width, in every glyph tier", () => {
    const long = "bun test src servers statusline scripts opencode --timeout 60000";
    const placed = receipt({
      plan: "a-rather-long-plan-name-for-a-narrow-row",
      tasks: [task(7, { title: "x".repeat(200), command: long }), task(8, { proof: "unproven", command: null }), task(9, { proof: null, command: null })],
      complete: { proven: 12, unproven: 2, failed: 1, isVerified: true },
    });
    for (const tier of ["nerd", "unicode", "ascii"] as const) {
      for (const columns of [20, 40, 78, 118, 198]) {
        for (const row of receiptRows(placed, glyphs(tier), columns)) expect(piecesWidth(row)).toBeLessThanOrEqual(columns);
      }
    }
  });
});
