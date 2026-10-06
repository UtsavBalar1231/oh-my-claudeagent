import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fixture, json, runNamed } from "./fixture.ts";
import { checks, EXPECTED_INVALID } from "./formats.ts";

afterEach(cleanup);

const REGISTRY = "tests/fixtures/boulder-schemas/two-plan.json";
const OLD_FLAT = "tests/fixtures/boulder-schemas/old-flat.json";
const LEDGER = "tests/mod/visual/fixtures/pane/.omca/evidence/verification-evidence.json";
const PLAN = "tests/fixtures/plans/clean.md";
const NOTE = "tests/mod/visual/fixtures/pane/.omca/notepads/some-plan/learnings.md";

const registry = json({ version: 1, plans: { a: { active_plan: "/p.md" } }, bindings: {} });
const ledger = json({ version: 1, entries: [{ type: "test", command: "just ci", exit_code: 0, output_snippet: "ok", timestamp: "2026-10-02T12:05:00Z" }] });
const plan = "# Plan\n\n- [ ] 1. Do it\n";
const note = "## 2026-10-02T10:00:00Z\nA finding.\n";

const run = (name: string, patch: Record<string, string | null>) => runNamed(checks, name, fixture(patch));

describe("formats", () => {
  test("a clean fixture set passes", async () => {
    const patch = { [REGISTRY]: registry, [LEDGER]: ledger, [PLAN]: plan, [NOTE]: note };
    expect(await run("registry fixtures", patch)).toMatchObject({ status: "pass" });
    expect(await run("ledger fixtures", patch)).toMatchObject({ status: "pass" });
    expect(await run("plan fixtures", patch)).toMatchObject({ status: "pass" });
    expect(await run("notepad fixtures", patch)).toMatchObject({ status: "pass" });
  });

  test("a tree without fixtures skips", async () => {
    for (const { name } of checks) expect(await run(name, {})).toMatchObject({ status: "skip" });
  });

  test("a corrupt registry is reported", async () => {
    expect(await run("registry fixtures", { [REGISTRY]: "{ nope ]" })).toEqual({
      status: "fail",
      detail: `${REGISTRY}: it is not valid JSON`,
    });
  });

  test("a plan whose tasks are all fenced is reported", async () => {
    expect(await run("plan fixtures", { [PLAN]: "```\n- [ ] 1. Example\n```\n" })).toEqual({
      status: "fail",
      detail: `${PLAN}: its numbered tasks are all inside code fences`,
    });
  });

  test("a ledger with a malformed entry and a notepad outside the section names are reported", async () => {
    const bad = json({ entries: [{ type: "test" }] });
    expect(await run("ledger fixtures", { [LEDGER]: bad })).toMatchObject({ status: "fail", detail: `${LEDGER}: 1 of its entries are malformed` });
    const stray = "tests/mod/visual/fixtures/pane/.omca/notepads/some-plan/misc.md";
    expect(await run("notepad fixtures", { [stray]: note })).toMatchObject({ status: "fail" });
  });

  test("an expected-invalid file that is valid is reported", async () => {
    expect(Object.keys(EXPECTED_INVALID)).toContain(OLD_FLAT);
    expect(await run("registry fixtures", { [OLD_FLAT]: registry })).toEqual({
      status: "fail",
      detail: `${OLD_FLAT} is listed as invalid on purpose but is valid`,
    });
  });

  test("an expected-invalid file that still fails passes", async () => {
    const flat = json({ active_plan: "/p.md", plan_name: "legacy" });
    expect(await run("registry fixtures", { [OLD_FLAT]: flat, [REGISTRY]: registry })).toMatchObject({ status: "pass" });
  });
});
