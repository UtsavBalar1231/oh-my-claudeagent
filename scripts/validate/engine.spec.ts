import { describe, expect, test } from "bun:test";
import { coreTypes, firstDifferentLine, forbiddenCalls, judgeCalls, judgePromptSubmitSources, judgeSkillTypes, judgeValidate, SKILL_TYPES, versionSkip } from "./engine.ts";

const REAL_OUTPUT = [
  "Validating hooks: /plugin/hooks/hooks.json",
  "",
  "  ❯ ./register.ts hooks: tool.check{tool=/Bash/}, session.start",
  "  ❯ ./register.ts calls: $.agent.list (via bindHost), $.fs.read (via bindHost), $.ui.log (via bindHost)",
  "  ❯ ./register.ts env reads: HOME",
].join("\n");

const withCalls = (...calls: string[]) =>
  `  ❯ ./register.ts calls: ${calls.map((call) => `$.${call} (via bindHost)`).join(", ")}\n`;

const IMPORT_FINDING = { path: "line 1, column 24", message: "error TS5097: An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled.", code: null };

const report = (contents: readonly object[], success = true) =>
  JSON.stringify({
    success,
    manifest: { file: "/p/.claude-plugin/plugin.json", type: "plugin", errors: [], warnings: [], notes: [] },
    contents,
  });

const section = (file: string, findings: { errors?: object[]; warnings?: object[] }) => ({ file, type: "hooks", errors: [], warnings: [], notes: [], ...findings });

describe("engine checks", () => {
  test("a clean report passes and names what it accepted", () => {
    expect(judgeValidate({ code: 0, stdout: report([]), stderr: "" }, "the marketplace")).toEqual({
      status: "pass",
      detail: "claude plugin validate accepts the marketplace",
    });
  });
});

describe("validate manifest", () => {
  test("a report whose only warnings are the type check's import-extension finding passes", () => {
    const stdout = report([section("/p/hooks/register.ts", { warnings: [IMPORT_FINDING, IMPORT_FINDING] })]);
    expect(judgeValidate({ code: 0, stdout, stderr: "" })).toMatchObject({ status: "pass" });
  });

  test("any other warning beside the import-extension finding fails, naming its file", () => {
    const other = { path: "line 3, column 1", message: "error TS2741: Property 'Progress' is missing", code: null };
    const stdout = report([section("/p/hooks/register.ts", { warnings: [IMPORT_FINDING, other] })]);
    expect(judgeValidate({ code: 0, stdout, stderr: "" })).toEqual({
      status: "fail",
      detail: "/p/hooks/register.ts: error TS2741: Property 'Progress' is missing",
    });
  });

  test("an unrecognized field warning in the manifest fails", () => {
    const stdout = JSON.stringify({
      success: true,
      manifest: { file: "/p/.claude-plugin/plugin.json", errors: [], warnings: [{ path: "engines", message: "Unrecognized field: engines" }] },
      contents: [],
    });
    expect(judgeValidate({ code: 0, stdout, stderr: "" })).toEqual({ status: "fail", detail: "/p/.claude-plugin/plugin.json: Unrecognized field: engines" });
  });

  test("an error fails even when it is the import-extension text", () => {
    const stdout = report([section("/p/hooks/register.ts", { errors: [IMPORT_FINDING] })], false);
    expect(judgeValidate({ code: 1, stdout, stderr: "" })).toMatchObject({ status: "fail" });
  });

  test("a failed run that names no finding still fails", () => {
    expect(judgeValidate({ code: 1, stdout: report([], false), stderr: "" })).toEqual({
      status: "fail",
      detail: "claude plugin validate exited 1 and reported no finding",
    });
  });

  test("output that is not a JSON report fails with its first lines", () => {
    const stderr = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
    expect(judgeValidate({ code: 1, stdout: "", stderr })).toEqual({
      status: "fail",
      detail: `claude plugin validate exited 1 without a JSON report: ${Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join(" | ")}`,
    });
    expect(judgeValidate({ code: 1, stdout: "bad module", stderr: "" })).toEqual({
      status: "fail",
      detail: "claude plugin validate exited 1 without a JSON report: bad module",
    });
  });
});

describe("mod calls line", () => {
  test("the calls the mod makes today pass", () => {
    expect(judgeCalls({ code: 0, stdout: REAL_OUTPUT, stderr: "" })).toMatchObject({ status: "pass" });
  });

  test.each(["model.fork", "model.complete", "model.classify", "http.fetch", "store.get", "store.set"])("%s on the calls line fails", (call) => {
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
    expect(forbiddenCalls(withCalls("http.fetch", "http.fetch", "prompt.fill", "storefront.x", "modelling.x"))).toEqual(["http.fetch"]);
  });

  test("the calls note of a JSON report is read, one note per line as the CLI prints it", () => {
    const notes = ["./register.ts hooks: session.start", "./register.ts calls: $.fs.read (via bindHost), $.http.fetch (via bindHost)", "./register.ts env reads: HOME"];
    const stdout = JSON.stringify({ success: true, manifest: { errors: [], warnings: [], notes }, contents: [] }, null, 2);
    expect(judgeCalls({ code: 0, stdout, stderr: "" })).toEqual({ status: "fail", detail: "the mod calls $.http.fetch" });
  });

  test("the calls line on stderr is read as well", () => {
    expect(judgeCalls({ code: 0, stdout: "", stderr: withCalls("model.fork") })).toMatchObject({ status: "fail" });
  });

  test("prompt.submit is accepted in the manifest only when the source boundary holds", () => {
    expect(judgeCalls({ code: 0, stdout: withCalls("prompt.submit"), stderr: "" })).toMatchObject({ status: "pass" });
    const allowed = { "hooks/register.ts": "submit: (args) => $.prompt.submit(args)", "hooks/refusal-recovery.ts": "await host.prompt.submit({ text })" };
    expect(judgePromptSubmitSources(allowed)).toMatchObject({ status: "pass" });
    expect(judgePromptSubmitSources({ ...allowed, "hooks/other.ts": "$.prompt.submit({ text: 'bad' })" })).toMatchObject({ status: "fail" });
    expect(judgePromptSubmitSources({ ...allowed, "hooks/other.ts": "const submit = $.prompt.submit; submit({ text: 'bad' })" })).toMatchObject({ status: "fail" });
    expect(judgePromptSubmitSources({ ...allowed, "hooks/other.ts": "engine.prompt['submit']({ text: 'bad' })" })).toMatchObject({ status: "fail" });
    expect(judgePromptSubmitSources({ ...allowed, "hooks/register.ts": `${allowed["hooks/register.ts"]}; $.prompt.submit({ text: 'bad' })` })).toMatchObject({ status: "fail" });
    expect(judgePromptSubmitSources({ ...allowed, "hooks/refusal-recovery.ts": "host.prompt.submit({ text })" })).toMatchObject({ status: "fail" });
    expect(judgePromptSubmitSources({ "hooks/register.ts": allowed["hooks/register.ts"] })).toMatchObject({ status: "fail" });
  });
});

describe("engine types match the skill", () => {
  const MARKER = "// The inputs of the built-in tools this build has, from each tool's";
  const CORE = "// Written by Claude Code 2.1.296.\ndeclare const a: 1;\n}\n\n";
  const generated = `${CORE}${MARKER}\n// input schema.\ntype Tools = {};\n`;
  const listing = ["claude-1000", "claude-1000/bundled-skills"];
  const holds = "the scratch temp folder holds: claude-1000, claude-1000/bundled-skills";

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
      detail: `the file matching ${SKILL_TYPES} has no line starting "// The inputs of the built-in tools"; the scratch temp folder holds: nothing`,
    });
  });

  test("a different installed version skips and names both versions", () => {
    expect(versionSkip("2.1.297", "2.1.296")).toEqual({
      status: "skip",
      detail: "claude 2.1.297 is installed and .claude-plugin/types/claude-code/index.d.ts was written by Claude Code 2.1.296; the comparison needs the same version",
    });
  });
});
