import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { GROUPS, main, runChecks } from "./validate.ts";
import { type Check, createContext, run } from "./validate/core.ts";
import { cleanup, fixture, json, makeTree, VALID } from "./validate/fixture.ts";

afterEach(cleanup);

function gitTree(patch: Record<string, string> = {}): string {
  const root = makeTree({ ...VALID, ...patch });
  expect(run(["git", "init", "-q"], root).code).toBe(0);
  expect(run(["git", "add", "-A"], root).code).toBe(0);
  return root;
}

const summary = (stdout: string) => stdout.trimEnd().split("\n").at(-1);

describe("main", () => {
  test("a consistent tree passes every check of the groups asked for, one line each, and exits 0", async () => {
    const result = await main(["--check", "hooks", "--check", "tree"], gitTree());
    const count = GROUPS.hooks.length + GROUPS.tree.length;
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(count + 1);
    expect(lines.slice(0, count).every((line) => line.startsWith("PASS: "))).toBe(true);
    expect(lines.at(-1)).toBe(`Summary: ${count} passed, 0 failed, 0 skipped, 0 warned`);
  });

  test("the claims group passes on a consistent tree and skips the source and references checks that have nothing to read", async () => {
    const result = await main(["--check", "claims"], gitTree());
    expect(result.code).toBe(0);
    expect(summary(result.stdout)).toBe(`Summary: ${GROUPS.claims.length - 2} passed, 0 failed, 2 skipped, 0 warned`);
  });

  test("a failing check exits 1, prints its FAIL line and counts it in the summary", async () => {
    const { hooks } = JSON.parse(VALID["hooks/hooks.json"] ?? "{}");
    const root = gitTree({ "hooks/hooks.json": json({ modules: ["./other.ts"], hooks }) });
    const result = await main(["--check", "hooks"], root);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('FAIL: hook modules: modules is ["./other.ts"], expected ["./register.ts"]\n');
    expect(summary(result.stdout)).toBe(`Summary: ${GROUPS.hooks.length - 1} passed, 1 failed, 0 skipped, 0 warned`);
  });

  test("--check may repeat and runs the groups in the order given", async () => {
    const result = await main(["--check", "tree", "--check", "hooks"], gitTree());
    const names = result.stdout.split("\n").flatMap((line) => /^PASS: ([^:]+):/.exec(line)?.[1] ?? []);
    expect(names).toEqual([...GROUPS.tree, ...GROUPS.hooks].map((check) => check.name));
  });

  test("--marketplace points the marketplace checks at another file and requires ./ path sources", async () => {
    const root = gitTree({ "other-marketplace.json": json({ name: "x", metadata: { version: "1.2.3" }, plugins: [{ name: "oh-my-claudeagent", version: "1.2.3", source: "." }] }) });
    const plain = await main(["--check", "claims"], root);
    expect(plain.stdout).toContain("SKIP: marketplace source:");
    const override = await main(["--check", "claims", "--marketplace", join(root, "other-marketplace.json")], root);
    expect(override.code).toBe(1);
    expect(override.stdout).toContain("FAIL: marketplace source: oh-my-claudeagent source '.' is not a ./ path\n");
  });

  test("an unknown group exits 2 and names it", async () => {
    const result = await main(["--check", "bats"], gitTree());
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.startsWith("Unsupported check 'bats'\nUsage: bun scripts/validate.ts")).toBe(true);
  });

  test("an unknown flag and a missing value exit 2 with the usage", async () => {
    for (const args of [["--bogus"], ["--check"], ["extra"]]) {
      const result = await main(args, gitTree());
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Usage: bun scripts/validate.ts");
    }
  });

  test("--help prints the usage, names every group and exits 0", async () => {
    const result = await main(["--help"], "/nonexistent");
    expect(result.code).toBe(0);
    for (const group of Object.keys(GROUPS)) expect(result.stdout).toContain(group);
  });
});

describe("runChecks", () => {
  const outcome = (status: "pass" | "fail" | "skip" | "warn"): Check => ({ name: status, run: () => ({ status, detail: `${status} detail` }) });

  test("every status is labelled and counted, and only a failure fails the run", async () => {
    const ctx = fixture();
    const clean = await runChecks([outcome("pass"), outcome("skip"), outcome("warn"), outcome("pass")], ctx);
    expect(clean).toEqual({
      lines: ["PASS: pass: pass detail", "SKIP: skip: skip detail", "WARN: warn: warn detail", "PASS: pass: pass detail", "Summary: 2 passed, 0 failed, 1 skipped, 1 warned"],
      failed: false,
    });
    const broken = await runChecks([outcome("pass"), outcome("fail")], ctx);
    expect(broken).toEqual({ lines: ["PASS: pass: pass detail", "FAIL: fail: fail detail", "Summary: 1 passed, 1 failed, 0 skipped, 0 warned"], failed: true });
  });

  test("a check that throws becomes a FAIL line with the error message and the run goes on", async () => {
    const boom: Check = {
      name: "boom",
      run: () => {
        throw new Error("no such file");
      },
    };
    const result = await runChecks([boom, outcome("pass")], createContext("/nonexistent"));
    expect(result).toEqual({
      lines: ["FAIL: boom: no such file", "PASS: pass: pass detail", "Summary: 1 passed, 1 failed, 0 skipped, 0 warned"],
      failed: true,
    });
  });

  test("an async check is awaited", async () => {
    const later: Check = { name: "later", run: async () => ({ status: "pass", detail: "done" }) };
    expect((await runChecks([later], fixture())).lines[0]).toBe("PASS: later: done");
  });
});
