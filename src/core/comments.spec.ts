import { describe, expect, test } from "bun:test";
import { type CommentGateMode, commentGateMode, type DenyOnce, judgeWrite, type Verdict } from "./comments.ts";

const HEAD =
  "[COMMENT CHECK] Detected AI slop comment patterns. Remove the quoted comments with a follow-up Edit unless they encode a non-obvious why.";
const restates = (text: string) => `Comment restates the following code line ("${text}"): delete it, or replace it with the non-obvious why.`;
const trivialDoc = (text: string) => `Doc comment adds nothing beyond the function name ("${text}"): delete it.`;
const filler = (text: string) => `Filler-word comment ("${text}"): delete it.`;

const advised = (wouldDeny: "tier1" | "tier2" | undefined, ...findings: string[]): Verdict => ({
  kind: "advise",
  text: [HEAD, ...findings].join(" "),
  wouldDeny,
});

const judge = (file_path: string, content: string) => judgeWrite("advise", { file_path, content }, undefined);

describe("commentGateMode", () => {
  test.each<[string | undefined, CommentGateMode]>([
    ["off", "off"],
    ["deny", "deny"],
    ["advise", "advise"],
    [undefined, "advise"],
    ["", "advise"],
    ["DENY", "advise"],
    ["strict", "advise"],
  ])("%p is %p", (value, expected) => {
    expect(commentGateMode(value)).toBe(expected);
  });
});

describe("the comment marker follows the file", () => {
  const narration = (marker: string) => `${marker} set the user name\nuser_name = input_value`;

  test.each([
    ["/r/a.sh", "#"],
    ["/r/a.py", "#"],
    ["/r/a.rb", "#"],
    ["/r/a.R", "#"],
    ["/r/a.r", "#"],
    ["/r/Makefile", "#"],
    ["Dockerfile", "#"],
    ["/r/justfile", "#"],
    ["/r/a.c", "//"],
    ["/r/a.ts", "//"],
    ["/r/a.go", "//"],
    ["/r/a.rs", "//"],
    ["/r/a.lua", "--"],
    ["/r/a.sql", "--"],
    ["/r/a.erl", "%"],
    ["/r/a.clj", ";"],
    ["/r/a.f90", "!"],
    ["/r/a.vb", "'"],
    ["/r/a.m", "//"],
    ["/r/a.m", "%"],
    ["/r/a.php", "#"],
    ["/r/a.php", "//"],
    ["/r/a.tf", "#"],
    ["/r/.sh", "#"],
    ["", "#"],
    ["", "//"],
    ["C:\\proj\\a.py", "#"],
    ["C:/proj/a.go", "//"],
    ["C:\\proj.d\\Makefile", "#"],
    ["\\\\srv\\share\\a.ts", "//"],
    ["/c/proj/a.lua", "--"],
    ["/Users/Me/Proj/a.rb", "#"],
  ])("%p reads %p as a comment", (path, marker) => {
    expect(judge(path, narration(marker))).toEqual(advised("tier2", restates("set the user name")));
  });

  test.each([
    ["/r/a.c", "#"],
    ["/r/a.h", "#"],
    ["/r/a.lua", "//"],
    ["/r/a.lua", "#"],
    ["/r/a.py", "//"],
    ["/r/a.sh", "//"],
    ["/r/a.ts", "#"],
    ["/r/a.erl", "#"],
    ["/r/a.m", "#"],
    ["/r/a.md", "#"],
    ["/r/a.json", "//"],
    ["/r/a.s", "#"],
    ["/r/a.css", "//"],
    ["/r/Makefile.bak", "#"],
    ["/r/not-a-Makefile", "#"],
    ["/r/py", "#"],
    ["C:\\proj.d\\py", "#"],
    ["C:\\proj\\a.py", "//"],
  ])("%p does not read %p as a comment", (path, marker) => {
    expect(judge(path, narration(marker))).toBeUndefined();
  });
});

describe("a test directory is exempt", () => {
  const narration = "# set the user name\nuser_name = input_value";

  test.each(["/r/tests/a.py", "C:\\r\\tests\\a.py", "C:/r/tests/a.py", "\\\\srv\\share\\tests\\a.py", "/c/r/tests/a.py", "/Users/Me/r/tests/a.py"])(
    "%p is not judged",
    (path) => {
      expect(judge(path, narration)).toBeUndefined();
    },
  );

  test.each(["/r/testsuite/a.py", "C:\\r\\testsuite\\a.py"])("%p is judged", (path) => {
    expect(judge(path, narration)).toEqual(advised("tier2", restates("set the user name")));
  });
});

describe("the one-line function check", () => {
  test("a doc comment over a one-line brace function names the camelCase words it repeats", () => {
    const content = "// returns the user id\nfunction getUserId() {\n  return this.id;\n}";
    expect(judge("/r/a.ts", content)).toEqual(advised("tier2", trivialDoc("returns the user id")));
  });

  test("a doc comment over a function with a longer body is not flagged", () => {
    const content = "// returns the user id\nfunction getUserId() {\n  const id = load();\n  return id;\n}";
    expect(judge("/r/a.ts", content)).toBeUndefined();
  });

  test("a doc comment over a one-line Python function with a blank line before the body is flagged", () => {
    const content = "# returns the user id\ndef get_user_id():\n\n    return self.id\n\nclass Other:\n    pass\n";
    expect(judge("/r/a.py", content)).toEqual(advised("tier2", restates("returns the user id"), trivialDoc("returns the user id")));
  });

  test("a doc comment over a Python function with two body lines is not flagged", () => {
    const content = "# returns the user id\ndef get_user_id():\n    x = 1\n    return self.id\n";
    expect(judge("/r/a.py", content)).toEqual(advised("tier2", restates("returns the user id")));
  });
});

describe("restating", () => {
  test("a comment with digits over a line that is not a numeric constant is still judged", () => {
    expect(judge("/r/a.py", "# 3600 seconds in an hour\nhour_seconds = compute(hour)")).toEqual(advised("tier2", restates("3600 seconds in an hour")));
  });

  test("a comment whose words are all stopwords or short never restates", () => {
    expect(judge("/r/a.py", "# do it\nvalue = do_it()")).toBeUndefined();
  });

  test("a comment above a blank line and then code is compared with that code", () => {
    expect(judge("/r/a.py", "# set the user name\n\nuser_name = input_value")).toEqual(advised("tier2", restates("set the user name")));
  });

  test("a comment above another comment is compared with neither", () => {
    expect(judge("/r/a.py", "# set the user name\n# for later\nuser_name = input_value")).toBeUndefined();
  });
});

describe("findings", () => {
  test("only the first five findings are reported", () => {
    const content = Array.from({ length: 7 }, (_, i) => `# obviously ${"abcdefg"[i]}`).join("\n");
    expect(judge("/r/a.py", content)).toEqual(
      advised(
        "tier2",
        ...["a", "b", "c", "d", "e"].map((letter) => filler(`obviously ${letter}`)),
        "Excessive consecutive comment lines (7 in a row) detected.",
      ),
    );
  });

  test("a bare FIXME is context-free and a FIXME with an owner is not", () => {
    expect(judge("/r/a.py", "# FIXME\nx = 1")).toEqual(advised("tier2", 'Context-free TODO/FIXME ("FIXME"): add an issue ref or TODO(owner):.'));
    expect(judge("/r/a.py", "# FIXME @alice\nx = 1")).toBeUndefined();
  });

  test("a TODO that explains itself in three words is not context-free", () => {
    expect(judge("/r/a.py", "# TODO: handle the retry\nx = 1")).toBeUndefined();
  });

  test("a tier-3 finding alone names no tier it would have denied", () => {
    const content = "# a\n# b\n# c\n# d\n# e\n# f\nx = 1";
    expect(judge("/r/a.py", content)).toEqual(
      advised(
        undefined,
        "Excessive consecutive comment lines (6 in a row) detected.",
        "High comment density (6 comment lines to 1 code lines): likely line-by-line narration rather than documentation.",
      ),
    );
  });

  test("a hunk of only comments has no density finding", () => {
    expect(judge("/r/a.py", "# a\n# b\n# c\n# d\n# e")).toBeUndefined();
  });

  test("a tier-1 finding names tier1 even beside a tier-2 finding", () => {
    expect(judge("/r/a.py", "# AI-generated helper\n# obviously this\nx = 1")).toEqual(
      advised("tier1", "AI attribution comment detected.", filler("obviously this")),
    );
  });
});

describe("deny mode", () => {
  const slop = { file_path: "/r/a.py", content: "# set the user name\nuser_name = input_value" };

  test("a deny names the finding and leaves the memory holding it", () => {
    const slot: DenyOnce = {};
    const verdict = judgeWrite("deny", slop, slot);
    expect(verdict).toMatchObject({ kind: "deny", reason: expect.stringContaining(restates("set the user name")) });
    expect(judgeWrite("deny", slop, slot)).toEqual(advised(undefined, restates("set the user name")));
    expect(slot).toEqual({});
  });

  test("with no memory a tier-2 finding advises rather than denies", () => {
    expect(judgeWrite("deny", slop, undefined)).toEqual(advised(undefined, restates("set the user name")));
  });

  test("the memory holds the last denial only", () => {
    const slot: DenyOnce = {};
    const other = { file_path: "/r/b.py", content: slop.content };
    expect(judgeWrite("deny", slop, slot)?.kind).toBe("deny");
    expect(judgeWrite("deny", other, slot)?.kind).toBe("deny");
    expect(judgeWrite("deny", slop, slot)?.kind).toBe("deny");
  });
});

describe("what is read", () => {
  test("an Edit new_string and a Write content are read alike", () => {
    const text = "# set the user name\nuser_name = input_value";
    expect(judgeWrite("advise", { file_path: "/r/a.py", new_string: text }, undefined)).toEqual(judgeWrite("advise", { file_path: "/r/a.py", content: text }, undefined));
  });

  test("patch fields other than patchText are read, and +++ headers are not content", () => {
    const patch = "--- a/a.py\n+++ b/a.py\n+# AI-generated helper\n+x = 1";
    for (const field of ["patchText", "input", "patch", "command"]) {
      expect(judgeWrite("advise", { file_path: "/r/a.py", [field]: patch }, undefined)).toEqual(advised("tier1", "AI attribution comment detected."));
    }
  });

  test("a patch's +++ header line is never a comment", () => {
    expect(judgeWrite("advise", { file_path: "/r/a.py", patchText: "+++ # AI-generated\n+x = 1" }, undefined)).toBeUndefined();
  });

  test("a tool input that is not an object judges nothing", () => {
    expect(judgeWrite("deny", undefined, undefined)).toBeUndefined();
    expect(judgeWrite("deny", "# AI-generated helper", undefined)).toBeUndefined();
  });
});
