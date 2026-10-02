import { describe, expect, test } from "bun:test";
import { KEYWORD_MODES, matchKeywordModes, SLASH_MODES } from "./keywords.ts";

const modesOf = (prompt: string): string[] => matchKeywordModes(prompt).map(({ name }) => name);

describe("trigger phrases", () => {
  test.each([
    ["handoff", "handoff please"],
    ["handoff", "my context is getting long"],
    ["handoff", "let's start fresh session now"],
    ["omca-setup", "setup omca on this machine"],
    ["omca-setup", "omca setup please"],
    ["metis", "run metis on the draft"],
    ["metis", "metis analyze the plan"],
    ["metis", "do some pre-plan work"],
    ["plan", "run prometheus"],
    ["plan", "prometheus plan the migration"],
    ["plan", "create plan for the auth rewrite"],
    ["hephaestus", "run hephaestus"],
    ["hephaestus", "hephaestus fix the types"],
    ["hephaestus", "the build is failing, fix build please"],
    ["hephaestus", "build broken again"],
  ])("%s fires on %p", (name, prompt) => {
    expect(modesOf(prompt)).toEqual([name]);
  });

  test("a phrase matches whatever case and whitespace the user typed", () => {
    expect(modesOf("Fix\n  BUILD")).toEqual(["hephaestus"]);
  });

  test("several modes in one prompt come back in table order", () => {
    expect(modesOf("create plan, then fix build, then handoff")).toEqual(["handoff", "plan", "hephaestus"]);
  });

  test("a prompt naming no phrase matches nothing", () => {
    expect(modesOf("fix the login bug")).toEqual([]);
    expect(modesOf("")).toEqual([]);
  });

  test("a phrase split by other words is not the phrase", () => {
    expect(modesOf("fix the build")).toEqual([]);
    expect(modesOf("the plan to create a build")).toEqual([]);
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
    expect(modesOf('he said "hello\nfix build please')).toEqual(["hephaestus"]);
  });

  test("single quotes do not cite a phrase", () => {
    expect(modesOf("it's time to fix build, isn't it")).toEqual(["hephaestus"]);
  });
});

describe("text the user did not type", () => {
  const paste = (body: string) => `<pasted_content id="a1b2">\n${body}\n</pasted_content id="a1b2">`;

  test("a phrase inside marked pasted text is ignored", () => {
    expect(modesOf(`look at this log\n${paste("error: build broken at step 3")}\nwhat failed?`)).toEqual([]);
  });

  test("a phrase typed outside the paste still fires", () => {
    expect(modesOf(`${paste("some log line")}\nfix build please`)).toEqual(["hephaestus"]);
  });

  test("an unterminated paste hides the rest of the prompt", () => {
    expect(modesOf('<pasted_content id="a1b2">\nfix build')).toEqual([]);
  });

  test("a paste marker that is not alone on its line hides nothing", () => {
    expect(modesOf('see <pasted_content id="a1b2"> fix build')).toEqual(["hephaestus"]);
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
