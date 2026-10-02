import { afterEach, describe, expect, test } from "bun:test";
import { checks } from "./docs.ts";
import { run } from "./core.ts";
import { cleanup, fixture, runNamed } from "./fixture.ts";

afterEach(cleanup);

const HOME = `${"/ho"}me/alice/project/file.ts`;
const WINDOWS_HOME = `C:${"\\"}Users${"\\"}bob`;
const TOKEN = `GITHUB_${"TOKEN"}=abc123def`;
const BEARER = `Bearer ${"a".repeat(24)}`;

describe("every docs check", () => {
  test("passes on a consistent tree, skipping only the references check that has nothing to read", async () => {
    const ctx = fixture();
    for (const check of checks) {
      const expected = check.name === "skill references" ? "skip" : "pass";
      expect(await check.run(ctx)).toMatchObject({ status: expected });
    }
  });
});

describe("depersonalization", () => {
  const leak = (content: string) => fixture({ "agents/leak.md": `${content}\n` });

  test("a home path, a Windows home path, a credential and a bearer token each fail at their line", async () => {
    const ctx = fixture({ "agents/leak.md": `ok\nsee ${HOME}\n${WINDOWS_HOME}\n${TOKEN}\nauth ${BEARER}\n` });
    expect(await runNamed(checks, "depersonalization", ctx)).toEqual({
      status: "fail",
      detail: [
        `agents/leak.md:2: home-path literal '${"/ho"}me/alice/'`,
        `agents/leak.md:3: windows home-path literal '${WINDOWS_HOME}'`,
        `agents/leak.md:4: credential-looking literal '${TOKEN}'`,
        `agents/leak.md:5: bearer-token-looking literal '${BEARER}'`,
      ].join("; "),
    });
  });

  test("documentation placeholders and variable references are not leaks", async () => {
    const ctx = leak(`${"/ho"}me/user/x ${"/Us"}ers/user/x GITHUB_${"TOKEN"}=$VALUE GITHUB_${"TOKEN"}=<token> API_${"KEY"}="x"`);
    expect(await runNamed(checks, "depersonalization", ctx)).toMatchObject({ status: "pass" });
  });

  test("an allowlist entry for the exact path and text excuses that match only", async () => {
    const allowlist = `# comment\nagents/leak.md:${TOKEN}\n`;
    const excused = fixture({ "agents/leak.md": `${TOKEN}\n`, "scripts/validate/allowlist.txt": allowlist });
    expect(await runNamed(checks, "depersonalization", excused)).toMatchObject({ status: "pass" });
    const otherFile = fixture({ "docs/other.md": `${TOKEN}\n`, "scripts/validate/allowlist.txt": allowlist });
    expect(await runNamed(checks, "depersonalization", otherFile)).toMatchObject({ status: "fail" });
    const otherText = fixture({ "agents/leak.md": `${TOKEN}0\n`, "scripts/validate/allowlist.txt": allowlist });
    expect(await runNamed(checks, "depersonalization", otherText)).toMatchObject({ status: "fail" });
  });

  test("files outside the shipped roots are not scanned", async () => {
    const ctx = fixture({ "tests/data.md": `${HOME}\n`, "CHANGELOG.md": `${HOME}\n` });
    expect(await runNamed(checks, "depersonalization", ctx)).toMatchObject({ status: "pass" });
  });

  test("a tree with nothing under the scan roots fails", async () => {
    const ctx = fixture({}, { tracked: () => ["CHANGELOG.md"] });
    expect(await runNamed(checks, "depersonalization", ctx)).toEqual({ status: "fail", detail: "no tracked files found under the scan roots" });
  });
});

describe("docs accuracy", () => {
  test("a cited recipe that is not in the justfile fails", async () => {
    const ctx = fixture({ "README.md": "Run `just test-bats` first.\n" });
    expect(await runNamed(checks, "docs accuracy", ctx)).toEqual({
      status: "fail",
      detail: "README.md:1 cites 'just test-bats' which is not a justfile recipe",
    });
  });

  test("a path under a repo directory that is not tracked fails", async () => {
    const ctx = fixture({ "docs/CONTRIBUTING.md": "Line one\nSee `scripts/gone.sh`.\n" });
    expect(await runNamed(checks, "docs accuracy", ctx)).toEqual({
      status: "fail",
      detail: "docs/CONTRIBUTING.md:2 references 'scripts/gone.sh' which does not exist in the repo",
    });
  });

  test("a stale path next to a removal note is documented history, not a reference", async () => {
    const ctx = fixture({ "README.md": "`scripts/gone.sh` was removed in 3.0.\n" });
    expect(await runNamed(checks, "docs accuracy", ctx)).toMatchObject({ status: "pass" });
  });

  test("scaffold placeholders, bare file names and unknown top-level names are not path claims", async () => {
    const ctx = fixture({ "README.md": "`agents/name.md` `plugin.json` `state/boulder.json` `elsewhere/file.ts`\n" });
    expect(await runNamed(checks, "docs accuracy", ctx)).toMatchObject({ status: "pass" });
  });

  test("a gitignored path is the reader's own state and passes", async () => {
    const ctx = fixture({ "README.md": "`.omca/state/boulder.json` and `.omca/gone.json`\n", ".gitignore": ".omca/\n" });
    expect(run(["git", "init", "-q"], ctx.root).code).toBe(0);
    expect(await runNamed(checks, "docs accuracy", ctx)).toMatchObject({ status: "pass" });
  });

  test("a tree without a justfile fails", async () => {
    const ctx = fixture({ justfile: null });
    expect(await runNamed(checks, "docs accuracy", ctx)).toEqual({ status: "fail", detail: `justfile missing at ${ctx.root}/justfile` });
  });
});

describe("skill references", () => {
  const withReferences = (skill: string, files: Record<string, string>) =>
    fixture({ "skills/demo/SKILL.md": skill, ...Object.fromEntries(Object.entries(files).map(([name, text]) => [`skills/demo/references/${name}`, text])) });

  test("a reference file that SKILL.md mentions passes", async () => {
    const ctx = withReferences("---\nname: demo\n---\nRead references/guide.md\n", { "guide.md": "x" });
    expect(await runNamed(checks, "skill references", ctx)).toMatchObject({ status: "pass" });
  });

  test("a mentioned reference that does not exist fails", async () => {
    const ctx = withReferences("---\nname: demo\n---\nRead references/guide.md and references/gone.md\n", { "guide.md": "x" });
    expect(await runNamed(checks, "skill references", ctx)).toEqual({
      status: "fail",
      detail: "demo SKILL.md references references/gone.md but it is missing",
    });
  });

  test("a reference file nothing mentions fails as an orphan", async () => {
    const ctx = withReferences("---\nname: demo\n---\nRead references/guide.md\n", { "guide.md": "x", "stray.md": "y" });
    expect(await runNamed(checks, "skill references", ctx)).toEqual({
      status: "fail",
      detail: "demo references/stray.md is not referenced from SKILL.md",
    });
  });

  test("a tree with no references directory skips", async () => {
    expect(await runNamed(checks, "skill references", fixture())).toEqual({
      status: "skip",
      detail: "no skills with a references/ directory found",
    });
  });
});

describe("claudemd template", () => {
  test("a guidance handler that no longer reads the template fails", async () => {
    const ctx = fixture({ "servers/hooks/guidance.ts": "export {};\n" });
    expect(await runNamed(checks, "claudemd template", ctx)).toEqual({
      status: "fail",
      detail: "servers/hooks/guidance.ts no longer reads templates/claudemd.md",
    });
  });

  test("a missing template fails", async () => {
    expect(await runNamed(checks, "claudemd template", fixture({ "templates/claudemd.md": null }))).toEqual({
      status: "fail",
      detail: "templates/claudemd.md is missing",
    });
  });
});

describe("phantom payload fields", () => {
  test.each(["payload.tool_error", "e.tool_result.success", "e.tool_result?.error", "input.tool_response.success", "input.tool_response?.success"])(
    "%s in a handler fails at its line",
    async (expression) => {
      const ctx = fixture({ "servers/hooks/one.ts": `const ok = 1;\nconst x = ${expression};\n` });
      expect(await runNamed(checks, "phantom payload fields", ctx)).toEqual({
        status: "fail",
        detail: `servers/hooks/one.ts:2: const x = ${expression};`,
      });
    },
  );

  test("the same names in a spec, or a field that exists, are not flagged", async () => {
    const ctx = fixture({
      "servers/hooks/one.spec.ts": "const x = e.tool_error;\n",
      "servers/hooks/one.ts": "const x = input.tool_response.content;\n",
    });
    expect(await runNamed(checks, "phantom payload fields", ctx)).toMatchObject({ status: "pass" });
  });
});
