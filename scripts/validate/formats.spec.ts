import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fixture, json, runNamed } from "./fixture.ts";
import { checks } from "./formats.ts";

afterEach(cleanup);

const LEDGER = "tests/mod/visual/fixtures/pane/.omca/evidence/verification-evidence.json";
const NOTE = "tests/mod/visual/fixtures/pane/.omca/notepads/some-plan/learnings.md";

const ledger = json({ version: 1, entries: [{ type: "test", command: "just ci", exit_code: 0, output_snippet: "ok", timestamp: "2026-10-02T12:05:00Z" }] });
const note = "## 2026-10-02T10:00:00Z\nA finding.\n";

const run = (name: string, patch: Record<string, string | null>) => runNamed(checks, name, fixture(patch));

describe("formats", () => {
  test("a clean fixture set passes", async () => {
    const patch = { [LEDGER]: ledger, [NOTE]: note };
    expect(await run("ledger fixtures", patch)).toMatchObject({ status: "pass" });
    expect(await run("notepad fixtures", patch)).toMatchObject({ status: "pass" });
  });

  test("a tree without fixtures skips", async () => {
    for (const { name } of checks) expect(await run(name, {})).toMatchObject({ status: "skip" });
  });

  test("a ledger with a malformed entry and a notepad outside the section names are reported", async () => {
    const bad = json({ entries: [{ type: "test" }] });
    expect(await run("ledger fixtures", { [LEDGER]: bad })).toMatchObject({ status: "fail", detail: `${LEDGER}: 1 of its entries are malformed` });
    const stray = "tests/mod/visual/fixtures/pane/.omca/notepads/some-plan/misc.md";
    expect(await run("notepad fixtures", { [stray]: note })).toMatchObject({ status: "fail" });
  });
});
