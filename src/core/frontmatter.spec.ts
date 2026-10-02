import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";

const AGENTS = join(import.meta.dir, "..", "..", "agents");

const doc = (...body: string[]): string => ["---", ...body, "---", "# Body", ""].join("\n");

test("scalars stay strings, keep colons and quotes inside the value, and lose one surrounding pair", () => {
  expect(
    parseFrontmatter(
      doc(
        "name: executor",
        'description: Use when asking "Where is X?": find it',
        'quoted: "a: b"',
        "single: 'plain'",
        "maxTurns: 30",
        "omitClaudeMd: true",
        "padded:    spaced out   ",
      ),
    ),
  ).toEqual({
    name: "executor",
    description: 'Use when asking "Where is X?": find it',
    quoted: "a: b",
    single: "plain",
    maxTurns: "30",
    omitClaudeMd: "true",
    padded: "spaced out",
  });
});

test("inline lists split on commas, unquote items and drop empty ones", () => {
  expect(parseFrontmatter(doc("tools: [Read, \"Grep\", 'Glob']", "none: []", "padded: [ a ,  b , ]"))).toEqual({
    tools: ["Read", "Grep", "Glob"],
    none: [],
    padded: ["a", "b"],
  });
});

test("block lists collect indented and flush items, and a key without a value is an empty list", () => {
  expect(
    parseFrontmatter(doc("disallowedTools:", "  - Write", "  - 'Edit'", "flush:", "- Agent", "empty:", "after: x")),
  ).toEqual({ disallowedTools: ["Write", "Edit"], flush: ["Agent"], empty: [], after: "x" });
});

test("blank lines and whole-line comments are skipped, and CRLF line endings parse", () => {
  expect(parseFrontmatter("---\r\n# note\r\n\r\nname: a\r\n  # indented note\r\nmodel: opus\r\n---\r\nBody")).toEqual({
    name: "a",
    model: "opus",
  });
});

test("a leading byte-order mark does not hide the block, with LF or CRLF endings", () => {
  expect(parseFrontmatter("\uFEFF---\nname: a\n---\nBody")).toEqual({ name: "a" });
  expect(parseFrontmatter("\uFEFF---\r\nname: a\r\nmodel: opus\r\n---\r\nBody")).toEqual({ name: "a", model: "opus" });
});

test("an inner --- line in the body does not extend the block", () => {
  expect(parseFrontmatter("---\nname: a\n---\ntext\n---\nmodel: x\n---\n")).toEqual({ name: "a" });
});

test.each([
  ["no frontmatter", "# Title\nname: a\n"],
  ["an unclosed block", "---\nname: a\nmodel: opus\n"],
  ["an indented opening fence", " ---\nname: a\n---\n"],
  ["an empty file", ""],
])("%s gives undefined", (_label, text) => {
  expect(parseFrontmatter(text)).toBeUndefined();
});

test("an empty block gives an empty object", () => {
  expect(parseFrontmatter("---\n---\nBody")).toEqual({});
});

test.each([
  ["a block scalar", doc("name: a", "description: >-", "  folded"), "frontmatter line 3: block scalars are not supported: description: >-"],
  ["a literal block scalar", doc("description: |"), "frontmatter line 2: block scalars are not supported: description: |"],
  ["a nested map", doc("name: a", "hooks:", "  pre:", "    run: x"), "frontmatter line 4: unsupported syntax:   pre:"],
  ["a list item before any key", doc("- a"), "frontmatter line 2: list item outside a list: - a"],
  ["a list item after a scalar", doc("name: a", "- b"), "frontmatter line 3: list item outside a list: - b"],
  ["a key without a space after the colon", doc("name:a"), "frontmatter line 2: unsupported syntax: name:a"],
  ["a stray line", doc("name: a", "just words"), "frontmatter line 3: unsupported syntax: just words"],
])("%s throws with the line number", (_label, text, message) => {
  expect(() => parseFrontmatter(text)).toThrow(message);
});

const AGENT_FIELDS: Record<string, Record<string, string | string[]>> = {
  executor: { model: "sonnet", effort: "high", color: "green", memory: "project", disallowedTools: ["Agent"] },
  explore: {
    model: "sonnet",
    effort: "high",
    omitClaudeMd: "true",
    color: "blue",
    memory: "project",
    maxTurns: "30",
    disallowedTools: ["Write", "Edit", "Agent"],
  },
  hephaestus: { model: "opus", effort: "medium", color: "yellow", memory: "project", disallowedTools: ["Agent"] },
  librarian: {
    model: "sonnet",
    effort: "high",
    omitClaudeMd: "true",
    color: "orange",
    memory: "project",
    disallowedTools: ["Write", "Edit", "Agent"],
  },
  metis: { model: "opus", effort: "high", color: "yellow", memory: "project", disallowedTools: ["Bash", "Agent"] },
  momus: { model: "opus", effort: "high", color: "red", memory: "project", disallowedTools: ["Bash", "Agent"] },
  "multimodal-looker": {
    model: "opus",
    effort: "medium",
    omitClaudeMd: "true",
    color: "pink",
    maxTurns: "15",
    disallowedTools: ["Agent", "Bash", "Edit", "Write", "Glob", "Grep", "NotebookEdit", "Skill"],
  },
  oracle: { model: "fable", effort: "xhigh", color: "purple", memory: "project", disallowedTools: ["Write", "Edit", "Agent"] },
  prometheus: { model: "opus", effort: "high", color: "cyan", memory: "project", disallowedTools: ["Bash"] },
  sisyphus: { model: "opus", effort: "high", color: "purple", memory: "project" },
};

test("every agents/*.md parses to exactly its declared fields, with the description taken verbatim", () => {
  const files = readdirSync(AGENTS).filter((file) => file.endsWith(".md")).sort();
  expect(files.map((file) => file.slice(0, -".md".length))).toEqual(Object.keys(AGENT_FIELDS).sort());
  for (const file of files) {
    const name = file.slice(0, -".md".length);
    const text = readFileSync(join(AGENTS, file), "utf8");
    const description = /^description: (.*)$/m.exec(text)?.[1];
    expect(description).toBeTruthy();
    expect(parseFrontmatter(text)).toEqual({ name, description: description ?? "", ...AGENT_FIELDS[name] });
  }
});
