import { describe, expect, test } from "bun:test";
import { isSlashCommand, KEYWORD_MODES, keywordSpans, matchKeywordModes, SLASH_MODES } from "./keywords.ts";

const modesOf = (prompt: string): string[] => matchKeywordModes(prompt).map(({ name }) => name);

describe("trigger phrases", () => {
  test.each([
    ["handoff", "handoff please"],
    ["handoff", "my context is getting long"],
    ["handoff", "let's start fresh session now"],
    ["omca-setup", "setup omca on this machine"],
    ["omca-setup", "omca setup please"],
    ["analyzer", "run analyzer on the draft"],
    ["analyzer", "analyze the plan"],
    ["analyzer", "analyze plan"],
    ["analyzer", "do some pre-plan work"],
    ["plan", "run planner"],
    ["plan", "create plan for the auth rewrite"],
    ["build-fixer", "run build-fixer"],
    ["build-fixer", "the build is failing, fix build please"],
    ["build-fixer", "build broken again"],
  ])("%s fires on %p", (name, prompt) => {
    expect(modesOf(prompt)).toEqual([name]);
  });

  test("a phrase matches whatever case and whitespace the user typed", () => {
    expect(modesOf("Fix\n  BUILD")).toEqual(["build-fixer"]);
  });

  test("several modes in one prompt come back in table order", () => {
    expect(modesOf("create plan, then fix build, then handoff")).toEqual(["handoff", "plan", "build-fixer"]);
  });

  test("a prompt naming no phrase matches nothing", () => {
    expect(modesOf("fix the login bug")).toEqual([]);
    expect(modesOf("")).toEqual([]);
  });

  test("a phrase split by other words is not the phrase", () => {
    expect(modesOf("fix the build")).toEqual([]);
    expect(modesOf("the plan to create a build")).toEqual([]);
  });

  test("a trigger word inside a longer word is not the phrase", () => {
    expect(modesOf("analyze plant growth")).toEqual([]);
    expect(modesOf("rerun analyzers")).toEqual([]);
  });
});

describe("a mention is not a request", () => {
  test.each(["the phrase", "the keyword", "the trigger", "the literal", "trigger phrase", "document that", "do not run", "don't run"])(
    "the meta-cue %p silences the prompt",
    (cue) => {
      expect(modesOf(`${cue}: fix build`)).toEqual([]);
    },
  );

  test("a meta-cue silences every mode in the prompt, not only the cited one", () => {
    expect(modesOf("handoff now, and does the phrase fix build trigger anything?")).toEqual([]);
  });

  test("double quotes and backticks cite a phrase", () => {
    expect(modesOf('I pasted "setup omca" into the doc')).toEqual([]);
    expect(modesOf("I pasted `setup omca` into the doc")).toEqual([]);
  });

  test("a phrase outside the quotes still fires beside a quoted one", () => {
    expect(modesOf('"fix build" is quoted but handoff is not')).toEqual(["handoff"]);
  });

  test("a quoted span never reaches across lines", () => {
    expect(modesOf('he said "hello\nfix build please')).toEqual(["build-fixer"]);
  });

  test("single quotes do not cite a phrase", () => {
    expect(modesOf("it's time to fix build, isn't it")).toEqual(["build-fixer"]);
  });
});

describe("text the user did not type", () => {
  const paste = (body: string) => `<pasted_content id="a1b2">\n${body}\n</pasted_content id="a1b2">`;

  test("a phrase inside marked pasted text is ignored", () => {
    expect(modesOf(`look at this log\n${paste("error: build broken at step 3")}\nwhat failed?`)).toEqual([]);
  });

  test("a paste with CRLF line endings is still ignored", () => {
    expect(modesOf('look at this\r\n<pasted_content id="a1b2">\r\nerror: build broken\r\n</pasted_content id="a1b2">\r\nwhat failed?')).toEqual([]);
    expect(modesOf('<pasted_content id="a1b2">\r\nsome log\r\n</pasted_content id="a1b2">\r\nfix build please')).toEqual(["build-fixer"]);
  });

  test("a phrase typed outside the paste still fires", () => {
    expect(modesOf(`${paste("some log line")}\nfix build please`)).toEqual(["build-fixer"]);
  });

  test("an unterminated paste hides the rest of the prompt", () => {
    expect(modesOf('<pasted_content id="a1b2">\nfix build')).toEqual([]);
  });

  test("a paste marker that is not alone on its line hides nothing", () => {
    expect(modesOf('see <pasted_content id="a1b2"> fix build')).toEqual(["build-fixer"]);
  });

  test("a task-notification relay is ignored when its tag sits in the first 500 characters", () => {
    expect(modesOf(`${"x".repeat(480)}<task-notification>handoff</task-notification>`)).toEqual([]);
  });

  test("the same tag past the first 500 characters does not silence the prompt", () => {
    expect(modesOf(`handoff ${"x".repeat(500)}<task-notification>`)).toEqual(["handoff"]);
  });
});

describe("slash modes", () => {
  test("only the handoff command is a mode", () => {
    expect([...SLASH_MODES.keys()]).toEqual(["oh-my-claudeagent:handoff"]);
    expect(SLASH_MODES.get("oh-my-claudeagent:handoff")?.name).toBe("handoff");
  });

  test("the slash and keyword modes share the handoff name that suppresses a repeat", () => {
    expect(KEYWORD_MODES.some(({ name }) => name === SLASH_MODES.get("oh-my-claudeagent:handoff")?.name)).toBe(true);
  });
});

describe("keywordSpans", () => {
  const spans = (prompt: string) => keywordSpans(prompt).map(({ name, start, end }) => [name, prompt.slice(start, end)]);

  test("names each phrase by its place in the prompt, in the order typed, in the case typed", () => {
    expect(spans("please Create Plan, then FIX\n  build and create plan")).toEqual([
      ["plan", "Create Plan"],
      ["build-fixer", "FIX\n  build"],
      ["plan", "create plan"],
    ]);
  });

  test("an offset still lands on the phrase past non-ASCII text, quoted spans and a paste", () => {
    const paste = '<pasted_content id="1">\ncreate plan\n</pasted_content id="1">';
    expect(spans(`İstanbul 日本語 "quoted" \`code\`\n${paste}\nfix build`)).toEqual([["build-fixer", "fix build"]]);
  });

  test.each([
    "the phrase create plan",
    'say "create plan" to it',
    "`fix build` is a phrase",
    "<task-notification>create plan</task-notification>",
    '<pasted_content id="1">\nfix build\n</pasted_content id="1">',
    "fix the build",
  ])("what the detector does not fire on marks nothing: %p", (prompt) => {
    expect(matchKeywordModes(prompt)).toEqual([]);
    expect(keywordSpans(prompt)).toEqual([]);
  });

  test.each([
    "handoff please",
    "my context is getting long",
    "setup omca on this machine",
    "run analyzer on the draft",
    "do some pre-plan work",
    "create plan for the auth rewrite",
    "build broken again",
  ])("what the detector fires on marks that mode: %p", (prompt) => {
    expect(keywordSpans(prompt).map(({ name }) => name)).toEqual(matchKeywordModes(prompt).map(({ name }) => name));
    expect(keywordSpans(prompt).length).toBeGreaterThan(0);
  });
});

describe("isSlashCommand", () => {
  test("is a leading command word and nothing else", () => {
    expect(isSlashCommand("/oh-my-claudeagent:plan create plan")).toBe(true);
    expect(isSlashCommand("  /omca")).toBe(true);
    expect(isSlashCommand("create plan in /tmp")).toBe(false);
    expect(isSlashCommand("/tmp/x is a path")).toBe(false);
  });
});
