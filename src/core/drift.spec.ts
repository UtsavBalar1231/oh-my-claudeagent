import { describe, expect, test } from "bun:test";
import { addedLines, hasCompletionClaim, isStubFinding, stripPairedSpans } from "./drift.ts";

const UNFINISHED = "TODO: imple" + "ment";

describe("completion claims", () => {
  const cases: [string, boolean][] = [
    ["All done, implemented and fixed.", true],
    ["Ready for review.", true],
    ["The parser is completed", true],
    ['You asked whether the parser is "done" — the answer is no.', false],
    ["Run `just done` next.", false],
    ["This is not done yet.", false],
    ["I haven't finished the parser.", false],
    ["The suite is not green, so the parser path is fixed nowhere yet.", false],
    ["Earlier the suite was not green. The parser is fixed now.", true],
    ["No tests ran; the parser is fixed.", true],
    ["Nothing changed.", false],
  ];
  for (const [message, expected] of cases) {
    test(`${JSON.stringify(message)} is ${expected ? "" : "not "}a claim`, () => {
      expect(hasCompletionClaim(message)).toBe(expected);
    });
  }
});

describe("stripPairedSpans", () => {
  test("blanks a span that closes on its own line and keeps an unpaired delimiter", () => {
    expect(stripPairedSpans("say \"hi\" and \"bye\" then \"open", '"')).toBe('say "" and "" then "open');
  });

  test("never pairs delimiters across a newline", () => {
    expect(stripPairedSpans("don't\nit's", "'")).toBe("don't\nit's");
  });
});

describe("added lines", () => {
  test("numbers each added line from its hunk header and skips removed lines", () => {
    const diff = [
      "diff --git a/spec.js b/spec.js",
      "--- a/spec.js",
      "+++ b/spec.js",
      "@@ -3,3 +3 @@",
      "-c",
      "-d",
      "-e",
      "+x",
      "@@ -9 +7,2 @@",
      "-old",
      "+y",
      "+z",
    ].join("\n");
    expect(addedLines(diff)).toEqual([
      { file: "spec.js", line: 3, text: "x" },
      { file: "spec.js", line: 7, text: "y" },
      { file: "spec.js", line: 8, text: "z" },
    ]);
  });

  test("a path with a space loses the trailing tab git appends, and a deleted file adds nothing", () => {
    const diff = ["--- /dev/null", "+++ b/my file.js\t", "@@ -0,0 +1 @@", "+a", "--- a/gone.js", "+++ /dev/null", "@@ -1 +0,0 @@", "-b"].join("\n");
    expect(addedLines(diff)).toEqual([{ file: "my file.js", line: 1, text: "a" }]);
  });

  test("a +++ line that does not follow a --- line is added text", () => {
    expect(addedLines(["--- a/x.sh", "+++ b/x.sh", "@@ -1 +1,2 @@", "+++ counter", "+next"].join("\n"))).toEqual([
      { file: "x.sh", line: 1, text: "++ counter" },
      { file: "x.sh", line: 2, text: "next" },
    ]);
  });
});

describe("stub findings", () => {
  const cases: [string, string, boolean][] = [
    ["a.sh", `# ${UNFINISHED} the parser`, true],
    ["a.sh", `MARKER='${UNFINISHED}'`, false],
    ["notes.md", `${UNFINISHED} the parser`, false],
    ["suite.bats", `@test "${UNFINISHED} is reported" {`, false],
    ["suite.bats", `\t# ${UNFINISHED}`, true],
    ["spec.ts", "it.only('x', () => {})", true],
    ["helper.sh", "it.only(1)", false],
    ["orm.py", "qs = Model.objects.only('id')", false],
    ["impl.py", "raise NotImplementedError", false],
    ["impl.js", 'throw new Error("not imple' + 'mented yet")', true],
  ];
  for (const [file, text, expected] of cases) {
    test(`${file}: ${JSON.stringify(text)} is ${expected ? "" : "not "}a finding`, () => {
      expect(isStubFinding({ file, line: 1, text })).toBe(expected);
    });
  }
});
