import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fixture, runNamed } from "./fixture.ts";
import { checks, descriptionLength, frontmatterLines, scalar, topLevelKeys } from "./frontmatter.ts";

afterEach(cleanup);

const agent = (...lines: string[]) => `---\n${lines.join("\n")}\n---\nBody\n`;
const skill = (...lines: string[]) => `---\nname: demo\n${lines.join("\n")}\n---\nBody\n`;

describe("frontmatter keys", () => {
  test("frontmatter keys: a misspelled agent key and an unknown skill key fail", async () => {
    const ctx = fixture({
      "agents/demo.md": agent("name: demo", "description: d", "model: opus", "disallowed_tools:", "  - Agent"),
      "skills/demo/SKILL.md": skill("description: d", "foo: bar"),
    });
    expect(await runNamed(checks, "frontmatter keys", ctx)).toEqual({
      status: "fail",
      detail: "the platform ignores these keys without an error (agents/demo.md:disallowed_tools skills/demo/SKILL.md:foo)",
    });
  });

  test("frontmatter keys: an effort value outside the enum fails", async () => {
    const ctx = fixture({ "agents/demo.md": agent("name: demo", "description: d", "model: opus", "effort: hgih") });
    expect(await runNamed(checks, "frontmatter effort", ctx)).toEqual({
      status: "fail",
      detail: "effort values outside the platform enum (agents/demo.md:hgih)",
    });
  });

  test("frontmatter keys: valid agent and skill frontmatter passes", async () => {
    const ctx = fixture({
      "agents/demo.md": agent("name: demo", "description: d", "model: opus", "effort: high", "disallowedTools:", "  - Agent"),
      "skills/demo/SKILL.md": skill("description: d", "context: fork", "agent: demo", "effort: medium"),
    });
    expect(await runNamed(checks, "frontmatter keys", ctx)).toMatchObject({ status: "pass" });
    expect(await runNamed(checks, "frontmatter effort", ctx)).toMatchObject({ status: "pass" });
  });

  test("every platform effort level passes", async () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      const ctx = fixture({ "agents/demo.md": agent("name: demo", `effort: ${effort}`) });
      expect(await runNamed(checks, "frontmatter effort", ctx)).toMatchObject({ status: "pass" });
    }
  });
});

describe("agent frontmatter", () => {
  test("a tools allowlist fails", async () => {
    const ctx = fixture({ "agents/demo.md": agent("name: demo", "tools: Read, Grep") });
    expect(await runNamed(checks, "agent frontmatter", ctx)).toEqual({
      status: "fail",
      detail: "agents/demo.md: a tools allowlist drops every tool it omits, use disallowedTools",
    });
  });

  test("a colon in the name fails", async () => {
    const ctx = fixture({ "agents/demo.md": agent("name: oh-my-claudeagent:demo") });
    expect(await runNamed(checks, "agent frontmatter", ctx)).toEqual({
      status: "fail",
      detail: "agents/demo.md: name must not contain ':', the platform rejects the agent at load time",
    });
  });

  test("a maxTurns key fails", async () => {
    const ctx = fixture({ "agents/demo.md": agent("name: demo", "maxTurns: 30") });
    expect(await runNamed(checks, "agent frontmatter", ctx)).toEqual({
      status: "fail",
      detail: "agents/demo.md: maxTurns truncates the agent mid-task, let it stop on its own conditions",
    });
  });

  test("a directory with no agent files fails", async () => {
    const ctx = fixture({ "agents/demo.md": null });
    const result = await runNamed(checks, "agent frontmatter", ctx);
    expect(result).toEqual({ status: "fail", detail: `no agent files found in ${ctx.agentsDir}` });
  });
});

describe("skill description cap", () => {
  const long = (length: number) => `description: ${"x".repeat(length)}`;

  test("a description at the soft cap passes and one past it warns", async () => {
    expect(await runNamed(checks, "skill description cap", fixture({ "skills/demo/SKILL.md": skill(long(512)) }))).toMatchObject({ status: "pass" });
    expect(await runNamed(checks, "skill description cap", fixture({ "skills/demo/SKILL.md": skill(long(513)) }))).toEqual({
      status: "warn",
      detail: "description plus when_to_use over 512 characters, older clients may truncate: demo (513)",
    });
  });

  test("a description past the platform cap fails", async () => {
    expect(await runNamed(checks, "skill description cap", fixture({ "skills/demo/SKILL.md": skill(long(1537)) }))).toEqual({
      status: "fail",
      detail: "description plus when_to_use over the 1536 character platform cap: demo (1537)",
    });
  });

  test("when_to_use counts toward the cap, joined to the description by one space", async () => {
    const source = skill("description: aaaa", "when_to_use: |", "  bb", "  cc");
    expect(descriptionLength(frontmatterLines(source) ?? [])).toBe("aaaa bb\ncc".length);
    const ctx = fixture({ "skills/demo/SKILL.md": skill(long(1000), `when_to_use: ${"y".repeat(537)}`) });
    expect(await runNamed(checks, "skill description cap", ctx)).toMatchObject({ status: "fail" });
  });

  test("a tree without skills skips", async () => {
    expect(await runNamed(checks, "skill description cap", fixture({ "skills/demo/SKILL.md": null, "skills/omca-setup/SKILL.md": null }))).toEqual({
      status: "skip",
      detail: "no SKILL.md files found under skills/",
    });
  });
});

describe("frontmatter reading", () => {
  test("a file without a leading fence has no frontmatter", () => {
    expect(frontmatterLines("name: demo\n")).toBeUndefined();
  });

  test("an unterminated block reads to the end of the file", () => {
    expect(frontmatterLines("---\nname: demo\nmodel: opus\n")).toEqual(["name: demo", "model: opus", ""]);
  });

  test("only unindented key lines are keys", () => {
    expect(topLevelKeys(["name: demo", "disallowed-tools:", "  - Agent", "  indented: no", "# note: no"])).toEqual(["name", "disallowed-tools"]);
  });

  test("scalar reads plain, quoted, continued and block values", () => {
    expect(scalar(["name: demo"], "name")).toBe("demo");
    expect(scalar(['description: "Quoted: yes"'], "description")).toBe("Quoted: yes");
    expect(scalar(["description: first", "  second"], "description")).toBe("first second");
    expect(scalar(["description: >-", "  folded", "  text", "model: opus"], "description")).toBe("folded text");
    expect(scalar(["when_to_use: |", "  one", "  two"], "when_to_use")).toBe("one\ntwo");
    expect(scalar(["name: demo"], "effort")).toBeUndefined();
  });
});
