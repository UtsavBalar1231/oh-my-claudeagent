import { describe, expect, test } from "bun:test";
import { coreTypes, firstDifferentLine, forbiddenCalls, judgeCalls, judgeSkillTypes, judgeValidate, SKILL_TYPES, versionSkip } from "./engine.ts";

const REAL_OUTPUT = [
  "Validating hooks: /plugin/hooks/hooks.json",
  "",
  "  ❯ ./register.ts hooks: tool.check{tool=/Bash/}, session.start",
  "  ❯ ./register.ts calls: $.agent.list (via bindHost), $.fs.read (via bindHost), $.ui.log (via bindHost)",
  "  ❯ ./register.ts env reads: HOME",
].join("\n");

const withCalls = (...calls: string[]) =>
  `  ❯ ./register.ts calls: ${calls.map((call) => `$.${call} (via bindHost)`).join(", ")}\n`;

describe("engine checks", () => {
  test("a strict marketplace run that exits 0 passes and names what it accepted", () => {
    expect(judgeValidate({ code: 0, stdout: "", stderr: "" }, "the marketplace under --strict")).toEqual({
      status: "pass",
      detail: "claude plugin validate accepts the marketplace under --strict",
    });
  });
});

describe("validate manifest", () => {
  test("a zero exit passes", () => {
    expect(judgeValidate({ code: 0, stdout: REAL_OUTPUT, stderr: "" })).toMatchObject({ status: "pass" });
  });

  test("a non-zero exit fails with the first lines of the output", () => {
    const stderr = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
    expect(judgeValidate({ code: 1, stdout: "", stderr })).toEqual({
      status: "fail",
      detail: `claude plugin validate exited 1: ${Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join(" | ")}`,
    });
  });

  test("a failing run that printed only to stdout still explains itself", () => {
    expect(judgeValidate({ code: 1, stdout: "bad module", stderr: "" })).toEqual({
      status: "fail",
      detail: "claude plugin validate exited 1: bad module",
    });
  });
});

describe("mod calls line", () => {
  test("the calls the mod makes today pass", () => {
    expect(judgeCalls({ code: 0, stdout: REAL_OUTPUT, stderr: "" })).toMatchObject({ status: "pass" });
  });

  test.each(["prompt.submit", "model.fork", "http.fetch", "store.get", "store.set"])("%s on the calls line fails", (call) => {
    expect(judgeCalls({ code: 0, stdout: withCalls("fs.read", call), stderr: "" })).toEqual({
      status: "fail",
      detail: `the mod calls $.${call}`,
    });
  });

  test("a call named only outside the calls line is not read", () => {
    const stdout = `${REAL_OUTPUT}\n  ❯ ./register.ts env reads: prompt.submit\n`;
    expect(forbiddenCalls(stdout)).toEqual([]);
  });

  test("each forbidden call is reported once, and similar names are not forbidden", () => {
    expect(forbiddenCalls(withCalls("http.fetch", "http.fetch", "prompt.fill", "storefront.x", "model.list"))).toEqual(["http.fetch"]);
  });

  test("the calls line on stderr is read as well", () => {
    expect(judgeCalls({ code: 0, stdout: "", stderr: withCalls("model.fork") })).toMatchObject({ status: "fail" });
  });
});

describe("engine types match the skill", () => {
  const MARKER = "// The inputs of the built-in tools this build has, from each tool's";
  const CORE = "// Written by Claude Code 2.1.296.\ndeclare const a: 1;\n}\n\n";
  const generated = `${CORE}${MARKER}\n// input schema.\ntype Tools = {};\n`;
  const listing = ["claude-1000", "claude-1000/bundled-skills"];
  const holds = "the scratch TMPDIR holds: claude-1000, claude-1000/bundled-skills";

  test("the cut ends before the tools marker and keeps the blank line above it", () => {
    expect(coreTypes(generated)).toBe(CORE);
  });

  test("CRLF line ends are normalized before the cut", () => {
    expect(coreTypes(generated.replaceAll("\n", "\r\n"))).toBe(CORE);
  });

  test("the marker counts only at the start of a line", () => {
    expect(coreTypes(`const x = "${MARKER}";\n`)).toBeUndefined();
    expect(coreTypes(`${MARKER}\n`)).toBe("");
  });

  test("an identical core passes, whatever follows the marker", () => {
    expect(judgeSkillTypes(`${generated}type More = 1;\n`, CORE.replaceAll("\n", "\r\n"), listing)).toEqual({
      status: "pass",
      detail: ".claude-plugin/types/claude-code/index.d.ts matches the plugin-authoring skill's types up to the tools section",
    });
  });

  test("a line appended to the committed file fails at the line after the generated core", () => {
    expect(judgeSkillTypes(generated, `${CORE}extra\n`, listing)).toEqual({
      status: "fail",
      detail: ".claude-plugin/types/claude-code/index.d.ts differs from the plugin-authoring skill's types at line 5; run `just types`",
    });
  });

  test("a changed line fails at that line", () => {
    expect(firstDifferentLine(CORE, CORE.replace("a: 1", "a: 2"))).toBe(2);
  });

  test("no generated file fails with the glob and the scratch listing", () => {
    expect(judgeSkillTypes(undefined, CORE, listing)).toEqual({
      status: "fail",
      detail: `no file matches ${SKILL_TYPES}; ${holds}`,
    });
  });

  test("a generated file without the marker fails with the glob and the scratch listing", () => {
    expect(judgeSkillTypes(CORE, CORE, [])).toEqual({
      status: "fail",
      detail: `the file matching ${SKILL_TYPES} has no line starting "// The inputs of the built-in tools"; the scratch TMPDIR holds: nothing`,
    });
  });

  test("a different installed version skips and names both versions", () => {
    expect(versionSkip("2.1.297", "2.1.296")).toEqual({
      status: "skip",
      detail: "claude 2.1.297 is installed and .claude-plugin/types/claude-code/index.d.ts was written by Claude Code 2.1.296; the comparison needs the same version",
    });
  });
});
