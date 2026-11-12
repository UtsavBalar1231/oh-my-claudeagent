import { expect, test } from "bun:test";
import { briefFields, briefSize } from "./brief.ts";

const EXPLORER = [
  "[CONTEXT]: Map every caller of the shared router in `src/`, including the generated adapters under `src/gen/` and the legacy entry points the harness wraps at start-up. The report feeds a compliance table, so cite `file:line` for each claim.",
  "",
  "[GOAL]: Decide, for each caller, whether it goes through the harness **today** and whether it would **after** the router refactor in PR #212 lands.",
  "",
  "[DOWNSTREAM]: One table row per caller, marked *true today*, *true after #212* or *false*, with evidence.",
  "",
  "[REQUEST]:",
  "1. Read every module that imports the router (direct imports, re-exports, lookups by string name) and list each call site with the harness wrapper it passes through, if any.",
  "2. Check each call site against these statements:",
  "   - (a) every request is authenticated before routing",
  "   - (b) no caller builds a route table by hand",
  "   - (c) retries are bounded by `HarnessPolicy.maxRetries`, never by the caller",
  "3. **SKIP**: tests, fixtures, vendored code and generated docs, except where (c) applies.",
  "",
  "Return: a table (`statement | today | after #212 | evidence`), then a short list of new risks.",
].join("\n");

test("an explorer brief splits into its four bracket fields with their exact bodies", () => {
  expect(EXPLORER.split("\n")).toHaveLength(15);
  const lines = EXPLORER.split("\n");
  expect(briefFields(EXPLORER)).toEqual([
    { label: "CONTEXT", num: "", body: (lines[0] ?? "").replace("[CONTEXT]: ", "") },
    { label: "GOAL", num: "", body: (lines[2] ?? "").replace("[GOAL]: ", "") },
    { label: "DOWNSTREAM", num: "", body: (lines[4] ?? "").replace("[DOWNSTREAM]: ", "") },
    { label: "REQUEST", num: "", body: lines.slice(7).join("\n") },
  ]);
});

const EXECUTOR = [
  "1. TASK: Wire the order summary panel.",
  "",
  "2. DONE WHEN:",
  "- the panel renders the totals",
  "- `just test` passes",
  "",
  "3. TOOLS: Read, Edit, Bash",
  "4. SCOPE: `src/panel/` only.",
  "5. CONTEXT: The panel reads from the cart store.",
  "",
  "```ts",
  "[TODO]: not a field",
  "1. NOPE: not a field either",
  "```",
  "",
  "| file | role |",
  "| --- | --- |",
  "| cart.ts | store |",
].join("\n");

test("a numbered executor brief keeps each number, and the context keeps its fence and table", () => {
  const fields = briefFields(EXECUTOR);
  expect(fields.map(({ label, num }) => [num, label])).toEqual([
    ["1", "TASK"],
    ["2", "DONE WHEN"],
    ["3", "TOOLS"],
    ["4", "SCOPE"],
    ["5", "CONTEXT"],
  ]);
  expect(fields[0]?.body).toBe("Wire the order summary panel.");
  expect(fields[1]?.body).toBe("- the panel renders the totals\n- `just test` passes");
  expect(fields[4]?.body).toBe(
    ["The panel reads from the cart store.", "", "```ts", "[TODO]: not a field", "1. NOPE: not a field either", "```", "", "| file | role |", "| --- | --- |", "| cart.ts | store |"].join("\n"),
  );
});

test("a line that only looks like a label starts no field", () => {
  for (const line of ["3. **SKIP**: x", "   SKIP: x", "Return: x", "## Steps", "```\n[TODO]: x\n```", "~~~\n[TODO]: x\n~~~"]) {
    expect(briefFields(line)).toEqual([{ label: "", num: "", body: line }]);
  }
  expect(briefFields("[CONTEXT]: a\n~~~\n[GOAL]: b\n```\n[GOAL]: c\n~~~\n[DONE]: d")).toEqual([
    { label: "CONTEXT", num: "", body: "a\n~~~\n[GOAL]: b\n```\n[GOAL]: c\n~~~" },
    { label: "DONE", num: "", body: "d" },
  ]);
});

test("a fence closes only on its own character at its length or longer", () => {
  const text = "[A B]: x\n````\n```\n[NOT]: y\n````\n[NEXT]: z";
  expect(briefFields(text).map(({ label }) => label)).toEqual(["A B", "NEXT"]);
});

test("text before the first label is an unlabeled field, dropped when it is blank", () => {
  expect(briefFields("Read this first.\n\n[GOAL]: ship it")).toEqual([
    { label: "", num: "", body: "Read this first." },
    { label: "GOAL", num: "", body: "ship it" },
  ]);
  expect(briefFields("\n\n[GOAL]: ship it")).toEqual([{ label: "GOAL", num: "", body: "ship it" }]);
});

test("plain text is a single unlabeled field", () => {
  expect(briefFields("Fix the rounding bug in totals.\nThen run the tests.")).toEqual([
    { label: "", num: "", body: "Fix the rounding bug in totals.\nThen run the tests." },
  ]);
});

test("a size reads the characters and lines with thousands grouped and singulars", () => {
  expect(briefSize(EXPLORER, "·")).toBe("1,102 chars · 15 lines");
  expect(briefSize("x".repeat(1_102) + "\n".repeat(14), "·")).toBe("1,116 chars · 15 lines");
  expect(briefSize("a", "·")).toBe("1 char · 1 line");
  expect(briefSize("a\nb", "-")).toBe("3 chars - 2 lines");
  expect(briefSize("x".repeat(1_234_567), "·")).toBe("1,234,567 chars · 1 line");
});
