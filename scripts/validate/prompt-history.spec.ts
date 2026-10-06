import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fixture, runNamed } from "./fixture.ts";
import { ALLOWED, checks } from "./prompt-history.ts";

afterEach(cleanup);

const check = (patch: Record<string, string | null>) => runNamed(checks, "prompt history", fixture(patch));

const CURATED = [
  "Handled by the analyzer, now part of the planner.",
  "The section (legacy spelling: Must NOT Have).",
  "The agent formerly called helper.",
  "The agent previously known as helper.",
  "The skill was removed in v2.10.",
  "This holds since v2.1 of the plugin.",
  "The flag exists in v2 only.",
  "A change from OMCA 2.21 on.",
  "The wiring changes after the port.",
  "Hold the guard until the servers merge.",
  "The tool used to be a script.",
  "The analyzer still runs once (unchanged, mandatory).",
  "Enter Socratic Interview Mode before Phase 1.",
  "Enter Socratic mode instead.",
  "The docs follow the hard cutover model.",
  "`boulder_write` and `file_read` are discovery-deferred tools.",
  "Load each through ToolSearch before calling it.",
];

describe("prompt history", () => {
  test("a tree without history phrasing passes", async () => {
    expect(await check({})).toMatchObject({ status: "pass" });
  });

  test("each curated phrase fails at its line in an agent body", async () => {
    for (const phrase of CURATED) {
      const result = await check({ "agents/leak.md": `ok\n${phrase}\n` });
      expect(result.status).toBe("fail");
      expect(result.detail).toStartWith("agents/leak.md:2: ");
    }
  });

  test("the failure names the phrase it matched", async () => {
    expect(await check({ "agents/leak.md": "Enter Socratic Interview Mode now.\n" })).toEqual({
      status: "fail",
      detail: "agents/leak.md:1: Socratic 'Socratic'",
    });
  });

  test("every file the model reads is in scope", async () => {
    for (const path of [
      "skills/demo/references/more.md",
      "output-styles/style.md",
      "templates/extra.md",
      "rules/demo.md",
      "opencode/overlays/demo.md",
      "AGENTS.md",
      "hooks/AGENTS.md",
      "servers/tools/demo.ts",
      "servers/hooks/demo.ts",
      "hooks/demo.ts",
      "src/core/demo.ts",
      "statusline/demo.ts",
    ]) {
      const result = await check({ [path]: "Replaces the old script, formerly called helper.\n" });
      expect(result.status).toBe("fail");
      expect(result.detail).toStartWith(`${path}:1: formerly`);
    }
  });

  test("the changelog, the docs, the specs and the plugin's own tooling are out of scope", async () => {
    const text = "Formerly called helper.\n";
    const result = await check({
      "CHANGELOG.md": text,
      "README.md": text,
      "docs/guide.md": text,
      "servers/hooks/demo.spec.ts": text,
      "scripts/validate/demo.ts": text,
      "src/core/demo.spec.ts": text,
      "statusline/demo.spec.ts": text,
    });
    expect(result).toMatchObject({ status: "pass" });
  });

  test("ordinary wording such as 'no longer' fails in markdown and passes in a code comment", async () => {
    expect(await check({ "skills/demo/SKILL.md": "---\nname: demo\n---\nThe repro no longer fails.\n" })).toMatchObject({ status: "fail" });
    expect(await check({ "servers/tools/demo.ts": "// drops bindings to plans that no longer exist\n" })).toMatchObject({ status: "pass" });
  });

  test("a phrase in frontmatter or a code fence fails too", async () => {
    expect(await check({ "skills/demo/SKILL.md": "---\nname: demo\ndescription: Formerly the helper.\n---\nBody\n" })).toMatchObject({
      status: "fail",
    });
    expect(await check({ "agents/leak.md": "```text\nformerly\n```\n" })).toMatchObject({ status: "fail" });
  });
});

describe("prompt history allowlist", () => {
  const entry = ALLOWED.find((candidate) => candidate.file === "agents/executor.md");
  if (entry === undefined) throw new Error("the allowlist has no executor entry");

  test("every entry states its reason", () => {
    for (const allowed of ALLOWED) expect(allowed.reason).not.toBe("");
  });

  test("an entry excuses its phrase on its line of its file", async () => {
    const result = await check({ "agents/executor.md": `---\nname: demo\n---\nNo ${entry.line} unless required.\n` });
    expect(result).toMatchObject({ status: "pass" });
  });

  test("the same wording in another file fails", async () => {
    const result = await check({
      "agents/executor.md": `No ${entry.line}.\n`,
      "agents/other.md": `No ${entry.line}.\n`,
    });
    expect(result).toEqual({ status: "fail", detail: `agents/other.md:1: legacy 'legacy'` });
  });

  test("another line of the excused file still fails", async () => {
    const result = await check({ "agents/executor.md": `No ${entry.line}.\nThe legacy script stays.\n` });
    expect(result).toEqual({ status: "fail", detail: "agents/executor.md:2: legacy 'legacy'" });
  });

  test("an entry whose file is scanned but no longer holds the wording fails", async () => {
    const result = await check({ "agents/executor.md": "---\nname: demo\n---\nNo fallbacks.\n" });
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("allowlist entry for agents/executor.md (legacy, 'legacy fallbacks') matches no line");
  });
});
