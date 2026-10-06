import { expect, test } from "bun:test";
import { breakerNote, bumpErrorCount, DECAY_MS, type ErrorCount } from "./error-counts.ts";

const T0 = 1_786_000_000_000;

function streak(errors: readonly string[], key = "Edit:edit_error", gap = 1_000): { counts: Map<string, ErrorCount>; last: ErrorCount } {
  const counts = new Map<string, ErrorCount>();
  let last: ErrorCount | undefined;
  errors.forEach((error, index) => {
    last = bumpErrorCount(counts, key, error, T0 + index * gap);
  });
  if (last === undefined) throw new Error("a streak needs at least one error");
  return { counts, last };
}

test("the first failure counts one and records its summary and time", () => {
  expect(streak(["boom"]).last).toEqual({ count: 1, lastFailureAt: T0, lastErrors: ["boom"] });
});

test("failures under one key accumulate and other keys keep their own count", () => {
  const { counts } = streak(["a", "b"]);
  expect(bumpErrorCount(counts, "Bash:bash_error", "c", T0 + 5_000).count).toBe(1);
  expect(bumpErrorCount(counts, "Edit:edit_error", "d", T0 + 6_000).count).toBe(3);
});

test("a gap longer than five minutes starts the streak over and drops the old summaries", () => {
  const counts = new Map<string, ErrorCount>();
  bumpErrorCount(counts, "k", "old", T0);
  bumpErrorCount(counts, "k", "older", T0 + 1_000);
  expect(bumpErrorCount(counts, "k", "fresh", T0 + 1_000 + DECAY_MS + 1)).toEqual({
    count: 1,
    lastFailureAt: T0 + 1_000 + DECAY_MS + 1,
    lastErrors: ["fresh"],
  });
});

test("a gap of exactly five minutes keeps the streak", () => {
  const counts = new Map<string, ErrorCount>();
  bumpErrorCount(counts, "k", "first", T0);
  expect(bumpErrorCount(counts, "k", "second", T0 + DECAY_MS).count).toBe(2);
});

test("only the three newest summaries are kept, newest first", () => {
  expect(streak(["one", "two", "three", "four"]).last.lastErrors).toEqual(["four", "three", "two"]);
});

test("a summary has its newlines flattened and stops at 160 characters", () => {
  const { last } = streak([`line one\nline two\n${"x".repeat(200)}`]);
  expect(last.lastErrors[0]).toBe(`line one line two ${"x".repeat(142)}`);
  expect(last.lastErrors[0]).toHaveLength(160);
});

test("the breaker note is empty until the third failure", () => {
  expect(streak(["a", "b"]).last.count).toBe(2);
  expect(breakerNote(streak(["a", "b"]).last)).toBe("");
});

test("the breaker note lists the attempts oldest first and names the advisor before architect", () => {
  expect(breakerNote(streak(["first issue", "second issue", "third issue"]).last)).toBe(
    "This tool has failed 3+ times, each failure within five minutes of the last. Attempts: 1) first issue 2) second issue 3) third issue. The count covers every failure of the tool, related or not. If these are repeated attempts at one fix, stop repeating it: change the approach, or ask for a diagnosis, from the advisor tool when you have it and from architect when you do not.",
  );
});

test("the breaker keeps firing past the third failure, listing only the last three attempts", () => {
  const note = breakerNote(streak(["one", "two", "three", "four"]).last);
  expect(note).toContain("Attempts: 1) two 2) three 3) four.");
});
