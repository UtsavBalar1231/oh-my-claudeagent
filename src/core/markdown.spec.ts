import { describe, expect, test } from "bun:test";
import { CODE_KEY, contentLines, inlineMarkdown, markdownPieces } from "./markdown.ts";
import { wrapPieces } from "./visual.ts";

describe("inlineMarkdown", () => {
  test("code spans take the code key and the words around them stay plain", () => {
    expect(inlineMarkdown("I ran `just typecheck` and then `just lint` in ~/dev, and both exited 0")).toEqual([
      { text: "I ran " },
      { text: "just typecheck", color: CODE_KEY },
      { text: " and then " },
      { text: "just lint", color: CODE_KEY },
      { text: " in ~/dev, and both exited 0" },
    ]);
  });

  test("in a muted row the code keeps its key and dims, and the words keep the row's color", () => {
    expect(inlineMarkdown("Ran `just ci` twice", { color: "inactive" })).toEqual([
      { text: "Ran ", color: "inactive" },
      { text: "just ci", color: CODE_KEY, dimColor: true },
      { text: " twice", color: "inactive" },
    ]);
  });

  test("bold, italic, struck and linked text take their styles and lose their markers", () => {
    expect(inlineMarkdown("**bold** and *em* and _also_ and ~~gone~~ and [docs](https://example.com/a)")).toEqual([
      { text: "bold", bold: true },
      { text: " and " },
      { text: "em", italic: true },
      { text: " and " },
      { text: "also", italic: true },
      { text: " and " },
      { text: "gone", strikethrough: true },
      { text: " and " },
      { text: "docs", underline: true },
    ]);
  });

  test("a heading's line is bold and a quote's italic, markers dropped", () => {
    expect(inlineMarkdown("## Summary of `x` ##")).toEqual([
      { text: "Summary of ", bold: true },
      { text: "x", bold: true, color: CODE_KEY },
    ]);
    expect(inlineMarkdown("> quoted `x`")).toEqual([
      { text: "quoted ", italic: true },
      { text: "x", italic: true, color: CODE_KEY },
    ]);
  });

  const literal = [
    "snake_case_names and file_name.ts stay",
    "a*b and 2 * 3 stay",
    "$HOME and ${PATH} stay",
    "**unbalanced bold",
    "[x] done and [y]",
    "```ts",
    "#hashtag is not a heading",
    "- a list item stays a list item",
    "1. so does a numbered one",
  ];
  for (const text of literal) {
    test(`text without a closed marker stays as written: ${JSON.stringify(text)}`, () => {
      expect(inlineMarkdown(text)).toEqual([{ text }]);
    });
  }

  test("a shell substitution in a code span, a longer fence around a backtick, and an escaped marker", () => {
    expect(inlineMarkdown("echo `date` now")).toEqual([{ text: "echo " }, { text: "date", color: CODE_KEY }, { text: " now" }]);
    expect(inlineMarkdown("``a ` tick``")).toEqual([{ text: "a ` tick", color: CODE_KEY }]);
    expect(inlineMarkdown("\\*not em\\* and \\`not code\\`")).toEqual([{ text: "*not em* and `not code`" }]);
  });

  test("an image keeps its alt text, and an autolink its address, both underlined", () => {
    expect(inlineMarkdown("see ![the chart](chart.png) at <https://example.com/x>")).toEqual([
      { text: "see " },
      { text: "the chart", underline: true },
      { text: " at " },
      { text: "https://example.com/x", underline: true },
    ]);
  });
});

describe("contentLines and markdownPieces", () => {
  test("blank, fence, rule and table-rule lines carry no words", () => {
    expect(contentLines("```ts\nconst a = 1\n```\n\n---\n| a | b |\n|---|:---:|\n * * *\nend")).toEqual(["const a = 1", "| a | b |", "end"]);
  });

  test("each content line renders on its own, joined by a space", () => {
    expect(markdownPieces("## Task\nFix `foo`.\n\n```\nrm -rf\n```")).toEqual([
      { text: "Task", bold: true },
      { text: " Fix " },
      { text: "foo", color: CODE_KEY },
      { text: ". rm -rf" },
    ]);
  });
});

describe("wrapPieces", () => {
  test("words wrap at spaces, keep their styles, and the spaces between them carry none", () => {
    expect(wrapPieces([{ text: "run " }, { text: "just ci", color: CODE_KEY }, { text: " now please" }], 10)).toEqual([
      [{ text: "run " }, { text: "just", color: CODE_KEY }],
      [{ text: "ci", color: CODE_KEY }, { text: " now" }],
      [{ text: "please" }],
    ]);
  });

  test("a word wider than the line is cut into lines of the width", () => {
    expect(wrapPieces([{ text: "abcdefghij", bold: true }], 4)).toEqual([[{ text: "abcd", bold: true }], [{ text: "efgh", bold: true }], [{ text: "ij", bold: true }]]);
  });
});
