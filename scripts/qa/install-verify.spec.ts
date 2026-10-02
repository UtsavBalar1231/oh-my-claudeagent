import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHookModules } from "./install-verify.ts";
import { createChecks } from "./lib.ts";

let plugin = "";
let lines: string[] = [];

const hooks = (body: unknown): void => {
  mkdirSync(join(plugin, "hooks"), { recursive: true });
  writeFileSync(join(plugin, "hooks", "hooks.json"), JSON.stringify(body));
};

beforeEach(() => {
  plugin = mkdtempSync(join(tmpdir(), "omca-install-verify-spec-"));
  lines = [];
});

afterEach(() => {
  rmSync(plugin, { recursive: true, force: true });
});

describe("checkHookModules", () => {
  test("passes when every named module is a file under hooks/", () => {
    hooks({ modules: ["./register.ts", "./extra.ts"] });
    writeFileSync(join(plugin, "hooks", "register.ts"), "");
    writeFileSync(join(plugin, "hooks", "extra.ts"), "");
    const checks = createChecks((line) => void lines.push(line));

    checkHookModules(checks, plugin);

    expect(lines).toEqual(["[qa] PASS: all 2 hook modules resolve inside the packaged tree"]);
  });

  test("fails once per module the package lost", () => {
    hooks({ modules: ["./register.ts", "./gone.ts"] });
    writeFileSync(join(plugin, "hooks", "register.ts"), "");
    const checks = createChecks((line) => void lines.push(line));

    checkHookModules(checks, plugin);

    expect(lines).toEqual(["[qa] FAIL: hook module does not resolve in package: ./gone.ts"]);
    expect(checks.counts).toEqual({ passed: 0, failed: 1 });
  });

  test("fails when hooks.json names no module", () => {
    hooks({ hooks: {} });
    const checks = createChecks((line) => void lines.push(line));

    checkHookModules(checks, plugin);

    expect(lines).toEqual([`[qa] FAIL: no hook modules named in ${join(plugin, "hooks", "hooks.json")}`]);
  });

  test("fails when hooks.json is missing", () => {
    const checks = createChecks((line) => void lines.push(line));

    checkHookModules(checks, plugin);

    expect(lines).toEqual([`[qa] FAIL: hooks.json missing from packaged tree at ${join(plugin, "hooks", "hooks.json")}`]);
  });
});
