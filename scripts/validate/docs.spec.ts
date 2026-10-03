import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
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

  test("a home path with no trailing slash fails at a line end, before whitespace, a quote or a bracket", async () => {
    const lines = [`CLAUDE_CONFIG_DIR=${"/ho"}me/alice`, `cd ${"/Us"}ers/bob && ls`, `"${"/ho"}me/carol"`, `(${"/ho"}me/dave)`];
    const ctx = fixture({ "agents/leak.md": `${lines.join("\n")}\n` });
    expect(await runNamed(checks, "depersonalization", ctx)).toEqual({
      status: "fail",
      detail: ["/ho" + "me/alice", "/Us" + "ers/bob", "/ho" + "me/carol", "/ho" + "me/dave"]
        .map((path, index) => `agents/leak.md:${index + 1}: home-path literal '${path}'`)
        .join("; "),
    });
  });

  test("a placeholder and an allowlisted path pass with or without the trailing slash", async () => {
    const ctx = fixture({
      "agents/leak.md": `${"/ho"}me/user\n${"/Us"}ers/user/\n${"/ho"}me/alice\n${"/ho"}me/bob/\n`,
      "scripts/validate/allowlist.txt": `agents/leak.md:${"/ho"}me/alice/\nagents/leak.md:${"/ho"}me/bob\n`,
    });
    expect(await runNamed(checks, "depersonalization", ctx)).toMatchObject({ status: "pass" });
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

  test("a JSON credential key and an Anthropic API key fail", async () => {
    const key = `sk-${"ant"}-api03-abcdefgh`;
    const ctx = fixture({ "settings.json": `{\n  "ANTHROPIC_API_${"KEY"}": "${key}"\n}\n` });
    expect(await runNamed(checks, "depersonalization", ctx)).toEqual({
      status: "fail",
      detail: [
        `settings.json:2: credential-looking JSON key '"ANTHROPIC_API_${"KEY"}": "${key}"'`,
        `settings.json:2: Anthropic API key '${key}'`,
      ].join("; "),
    });
  });

  test("a JSON credential key holding a placeholder or a variable passes", async () => {
    const ctx = fixture({ "settings.json": `{ "API_${"KEY"}": "<key>", "GH_${"TOKEN"}": "$GH_TOKEN", "X_${"SECRET"}": "" }\n` });
    expect(await runNamed(checks, "depersonalization", ctx)).toMatchObject({ status: "pass" });
  });

  test("every shipped file is scanned, CHANGELOG.md included, and nothing packaging leaves out", async () => {
    const shipped = fixture({ "CHANGELOG.md": `${HOME}\n` });
    expect(await runNamed(checks, "depersonalization", shipped)).toMatchObject({ status: "fail" });
    const unshipped = fixture({ "tests/data.md": `${HOME}\n`, "scripts/qa/x.ts": `${HOME}\n`, "servers/a.spec.ts": `${HOME}\n` });
    expect(await runNamed(checks, "depersonalization", unshipped)).toMatchObject({ status: "pass" });
  });

  test("an allowlist entry that matches nothing fails", async () => {
    const ctx = fixture({ "scripts/validate/allowlist.txt": `# why\nagents/gone.md:${TOKEN}\n` });
    expect(await runNamed(checks, "depersonalization", ctx)).toEqual({
      status: "fail",
      detail: `scripts/validate/allowlist.txt entry 'agents/gone.md:${TOKEN}' matches nothing`,
    });
  });

  test("a tree that ships nothing fails", async () => {
    const ctx = fixture({}, { tracked: () => ["tests/t.spec.ts"] });
    expect(await runNamed(checks, "depersonalization", ctx)).toEqual({ status: "fail", detail: "the tree ships no files to scan" });
  });
});

describe("phantom payload fields on an empty tree", () => {
  test("a tree with no hook handler file fails", async () => {
    const ctx = fixture({}, { tracked: () => ["agents/demo.md"] });
    expect(await runNamed(checks, "phantom payload fields", ctx)).toEqual({ status: "fail", detail: "no hook handler files found to scan" });
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
    const ctx = fixture({ "CONTRIBUTING.md": "Line one\nSee `scripts/gone.sh`.\n" });
    expect(await runNamed(checks, "docs accuracy", ctx)).toEqual({
      status: "fail",
      detail: "CONTRIBUTING.md:2 references 'scripts/gone.sh' which does not exist in the repo",
    });
  });

  test("a page under docs/ is read too", async () => {
    const ctx = fixture({ "docs/usage.md": "Run `just gone`.\n" });
    expect(await runNamed(checks, "docs accuracy", ctx)).toEqual({
      status: "fail",
      detail: "docs/usage.md:1 cites 'just gone' which is not a justfile recipe",
    });
  });

  test("only recipe headers count as recipes, not settings, aliases or recipe bodies", async () => {
    const justfile = 'set shell := ["bash", "-c"]\nalias t := test\n\n@quiet:\n\ttrue\n\ntest *args:\n\tlint\n';
    const ctx = fixture({ justfile, "README.md": "`just quiet` `just test` `just set` `just alias` `just lint`\n" });
    expect(await runNamed(checks, "docs accuracy", ctx)).toEqual({
      status: "fail",
      detail: ["set", "alias", "lint"].map((name) => `README.md:1 cites 'just ${name}' which is not a justfile recipe`).join("; "),
    });
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
    expect(await runNamed(checks, "docs accuracy", ctx)).toEqual({ status: "fail", detail: `justfile missing at ${join(ctx.root, "justfile")}` });
  });
});

describe("doc links", () => {
  test("links and images that resolve from each page pass", async () => {
    const ctx = fixture({
      "README.md": '[Usage](docs/usage.md) and <img src=".github/assets/hero.png" alt="A pane.">\n![Shot](./docs/usage.md#install)\n',
      "docs/usage.md": "[Reference](references.md#agents), [statusline](../statusline/) and [up](../README.md)\n",
      "docs/references.md": "[Hooks](#hooks)\n",
      ".github/assets/hero.png": "png",
      "statusline/README.md": "x\n",
    });
    expect(await runNamed(checks, "doc links", ctx)).toMatchObject({ status: "pass" });
  });

  test("a link or image that resolves to nothing fails at its line", async () => {
    const ctx = fixture({
      "README.md": 'Intro\n[Old guide](GUIDE.md)\n<img src=".github/assets/gone.png" alt="x">\n',
      "docs/usage.md": "[Known issues](reference/known-issues.md#trap)\n[Outside](../../elsewhere.md)\n",
    });
    expect(await runNamed(checks, "doc links", ctx)).toEqual({
      status: "fail",
      detail: [
        "README.md:2 links to 'GUIDE.md', which is not in the repo",
        "README.md:3 links to '.github/assets/gone.png', which is not in the repo",
        "docs/usage.md:1 links to 'reference/known-issues.md#trap', which is not in the repo",
        "docs/usage.md:2 links to '../../elsewhere.md', which is not in the repo",
      ].join("; "),
    });
  });

  test("external links, anchors, code spans and fenced blocks are not checked", async () => {
    const ctx = fixture({
      "CONTRIBUTING.md": "[Site](https://example.com) [Mail](mailto:a@b.c) [Here](#top) `[x](gone.md)`\n```md\n[y](gone.md)\n```\n",
    });
    expect(await runNamed(checks, "doc links", ctx)).toMatchObject({ status: "pass" });
  });

  test("a markdown file outside docs/ and the two root pages is not read", async () => {
    const ctx = fixture({ "tests/README.md": "[x](gone.md)\n", "docs/sub/page.md": "[y](gone.md)\n" });
    expect(await runNamed(checks, "doc links", ctx)).toMatchObject({ status: "pass" });
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
