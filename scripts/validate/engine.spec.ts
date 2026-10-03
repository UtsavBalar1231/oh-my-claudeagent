import { describe, expect, test } from "bun:test";
import { forbiddenCalls, judgeCalls, judgeValidate } from "./engine.ts";

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
