import { describe, expect, test } from "bun:test";
import { type CommentGateMode, commentGateMode, type DenyOnce, judgeWrite, type Verdict } from "./comments.ts";

const HEAD =
  "[COMMENT CHECK] Detected AI slop comment patterns. Remove the quoted comments with a follow-up Edit unless they encode a non-obvious why.";
const separator = (text: string) => `Decorative separator comment ("${text}"): delete it.`;
const contextFree = (text: string) => `Context-free TODO/FIXME ("${text}"): add an issue ref or TODO(owner):.`;

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
  const narration = (marker: string) => `${marker} ----\nuser_name = input_value`;

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
    ["C:\\proj\\a.py", "#"],
    ["C:/proj/a.go", "//"],
    ["C:\\proj.d\\Makefile", "#"],
    ["\\\\srv\\share\\a.ts", "//"],
    ["/c/proj/a.lua", "--"],
    ["/Users/Me/Proj/a.rb", "#"],
  ])("%p reads %p as a comment", (path, marker) => {
    expect(judge(path, narration(marker))).toEqual(advised("tier2", separator("----")));
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
  const narration = "# ----\nuser_name = input_value";

  test.each(["/r/tests/a.py", "C:\\r\\tests\\a.py", "C:/r/tests/a.py", "\\\\srv\\share\\tests\\a.py", "/c/r/tests/a.py", "/Users/Me/r/tests/a.py"])(
    "%p is not judged",
    (path) => {
      expect(judge(path, narration)).toBeUndefined();
    },
  );

  test.each(["/r/testsuite/a.py", "C:\\r\\testsuite\\a.py"])("%p is judged", (path) => {
    expect(judge(path, narration)).toEqual(advised("tier2", separator("----")));
  });
});

describe("findings", () => {
  test("only the first five findings are reported", () => {
    const content = Array.from({ length: 7 }, (_, i) => `# ${"-".repeat(i + 3)}`).join("\n");
    expect(judge("/r/a.py", content)).toEqual(
      advised("tier2", ...[3, 4, 5, 6, 7].map((length) => separator("-".repeat(length)))),
    );
  });

  test.each([
    ["dashes", "# ----------"],
    ["equals signs", "# =========="],
    ["stars spaced out", "# * * * * *"],
    ["tildes", "# ~~~~"],
  ])("a separator of %s is flagged", (_label, comment) => {
    expect(judge("/r/a.py", `${comment}\nx = 1`)).toEqual(advised("tier2", separator(comment.slice(2))));
  });

  test("a bare FIXME is context-free and a FIXME with an owner is not", () => {
    expect(judge("/r/a.py", "# FIXME\nx = 1")).toEqual(advised("tier2", contextFree("FIXME")));
    expect(judge("/r/a.py", "# FIXME @alice\nx = 1")).toBeUndefined();
  });

  test("a TODO with an issue reference is not context-free", () => {
    expect(judge("/r/a.py", "# TODO #123\nx = 1")).toBeUndefined();
    expect(judge("/r/a.py", "# TODO PROJ-42\nx = 1")).toBeUndefined();
  });

  test("a word that holds todo or fixme, such as autodoc, is not a TODO", () => {
    expect(judge("/r/a.py", "# autodoc generator\nx = 1")).toBeUndefined();
    expect(judge("/r/a.py", "# prefixmeta lookup\nx = 1")).toBeUndefined();
  });

  test("a TODO that explains itself in three words is not context-free", () => {
    expect(judge("/r/a.py", "# TODO: handle the retry\nx = 1")).toBeUndefined();
  });

  test("a line marked @allow is not judged", () => {
    expect(judge("/r/a.py", "# ---- @allow\nx = 1")).toBeUndefined();
  });

  test("an AI attribution, an authorship line and a placeholder are named, and tier 1 wins beside tier 2", () => {
    expect(judge("/r/a.py", "# AI-generated helper\nx = 1")).toEqual(advised("tier1", "AI attribution comment detected."));
    expect(judge("/r/a.py", "# This code was written by a model\nx = 1")).toEqual(advised("tier1", "AI authorship comment detected."));
    expect(judge("/r/a.py", "# TODO: implement\nx = 1")).toEqual(
      advised("tier1", "Unimplemented TODO placeholder detected.", contextFree("TODO: implement")),
    );
    expect(judge("/r/a.py", "# AI-generated helper\n# ----\nx = 1")).toEqual(advised("tier1", "AI attribution comment detected.", separator("----")));
  });
});

describe("comments the gate leaves alone", () => {
  const cases: [string, string, string][] = [
    [
      "a kernel C file with an SPDX line, a header and kernel-doc",
      "/r/drivers/gpu/rockchip_hdmi.c",
      [
        "// SPDX-License-Identifier: GPL-2.0",
        "//",
        "// Rockchip HDMI driver",
        "// Copyright (C) 2026 Example",
        "// Author: A. Person",
        "// Derived from the dw-hdmi bridge",
        "",
        "#include <linux/module.h>",
        "#include <linux/platform_device.h>",
        "",
        "/**",
        " * rockchip_hdmi_probe - probe the hdmi device",
        " * @pdev: the platform device",
        " *",
        " * Return: 0 on success, a negative errno otherwise.",
        " */",
        "static int rockchip_hdmi_probe(struct platform_device *pdev)",
        "{",
        "\treturn 0;",
        "}",
      ].join("\n"),
    ],
    [
      "a kernel C one-line comment naming the function below it",
      "/r/drivers/gpu/rockchip_hdmi.c",
      "// rockchip_hdmi_probe - probe the hdmi device\nstatic int rockchip_hdmi_probe(struct platform_device *pdev)\n{\n\treturn 0;\n}",
    ],
    [
      "a Rust file with module docs and item docs",
      "/r/src/config.rs",
      [
        "//! Configuration loading.",
        "//!",
        "//! Reads the file and returns a [`Config`].",
        "",
        "/// Parses the configuration text.",
        "///",
        "/// # Examples",
        "///",
        "/// ```",
        '/// let config = parse_config("timeout = 5").unwrap();',
        "/// ```",
        "pub fn parse_config(text: &str) -> Result<Config, Error> {",
        "    Config::from_text(text)",
        "}",
        "",
        "pub struct Config {",
        "    /// The timeout in seconds.",
        "    pub timeout: u64,",
        "}",
      ].join("\n"),
    ],
    ["a Go doc comment", "/r/user.go", "// GetUser returns the user by id.\nfunc GetUser(id int) *User {\n\treturn users[id]\n}"],
    [
      "Python module and function docstrings",
      "/r/a.py",
      '"""Load the user table."""\n\n\ndef get_user(user_id):\n    """Return the user with this id."""\n    return USERS[user_id]\n',
    ],
    ["a JSDoc block", "/r/a.ts", "/**\n * Returns the user id.\n * @returns the id\n */\nfunction getUserId() {\n  return this.id;\n}"],
    ["a comment that uses just for time", "/r/a.ts", "// just before the rename\nrename(from, to);"],
    ["a comment that restates the line below it", "/r/a.py", "# set the user name\nuser_name = input_value"],
    ["a long run of comment lines", "/r/a.py", "# a\n# b\n# c\n# d\n# e\n# f\n# g\nx = 1"],
    ["a dense hunk", "/r/a.py", "# a\nx = 1\n# b\n# c\n# d\n# e\n# f\n"],
    ["a filler-word comment", "/r/a.py", "# obviously this handles the edge case\nfoo()"],
  ];

  test.each(cases)("%s, in advise mode", (_label, path, content) => {
    expect(judge(path, content)).toBeUndefined();
  });

  test.each(cases)("%s, in deny mode", (_label, path, content) => {
    expect(judgeWrite("deny", { file_path: path, content }, new Map())).toBeUndefined();
  });
});

describe("deny mode", () => {
  const slop = { file_path: "/r/a.py", content: "# ----\nuser_name = input_value" };

  test("a deny names the finding and a retry passes and empties the memory", () => {
    const slot: DenyOnce = new Map();
    const verdict = judgeWrite("deny", slop, slot);
    expect(verdict).toMatchObject({ kind: "deny", reason: expect.stringContaining(separator("----")) });
    expect(slot.size).toBe(1);
    expect(judgeWrite("deny", slop, slot)).toEqual(advised(undefined, separator("----")));
    expect(slot.size).toBe(0);
  });

  test("with no memory a tier-2 finding advises rather than denies", () => {
    expect(judgeWrite("deny", slop, undefined)).toEqual(advised(undefined, separator("----")));
  });

  test("each file keeps its own denial, so interleaved writers each get their retry", () => {
    const slot: DenyOnce = new Map();
    const other = { file_path: "/r/b.py", content: slop.content };
    expect([slop, other, slop, other].map((input) => judgeWrite("deny", input, slot)?.kind)).toEqual(["deny", "deny", "advise", "advise"]);
    expect(slot.size).toBe(0);
  });

  test("a different finding on the same file is denied again", () => {
    const slot: DenyOnce = new Map();
    const changed = { file_path: slop.file_path, content: "# FIXME\nx = 1" };
    expect([slop, changed, changed].map((input) => judgeWrite("deny", input, slot)?.kind)).toEqual(["deny", "deny", "advise"]);
  });

  test("an attribution comment is denied every time, whatever the memory holds", () => {
    const slot: DenyOnce = new Map();
    const input = { file_path: "/r/a.py", content: "# AI-generated helper\nx = 1" };
    expect([input, input].map((write) => judgeWrite("deny", write, slot)?.kind)).toEqual(["deny", "deny"]);
  });

  test.each([
    ["a bare placeholder", "// TODO: implement"],
    ["a placeholder with one word", "// TODO: implement this"],
    ["a placeholder in the noun form", "// TODO: implementation"],
  ])("%s is denied", (_label, comment) => {
    const verdict = judgeWrite("deny", { file_path: "/r/a.ts", content: `${comment}\nfetch(url);` }, new Map());
    expect(verdict).toMatchObject({ kind: "deny", reason: expect.stringContaining("Unimplemented TODO placeholder detected.") });
  });

  test.each([
    ["a TODO that says what and why", "// TODO: implement the fallback path once the upstream exposes a retry budget"],
    ["a placeholder with an issue reference", "// TODO: implement #123"],
    ["a placeholder with a ticket reference", "// TODO: implement PROJ-42"],
  ])("%s passes", (_label, comment) => {
    expect(judgeWrite("deny", { file_path: "/r/a.ts", content: `${comment}\nfetch(url);` }, new Map())).toBeUndefined();
  });
});

describe("what is read", () => {
  test("an Edit new_string and a Write content are read alike", () => {
    const text = "# ----\nuser_name = input_value";
    expect(judgeWrite("advise", { file_path: "/r/a.py", new_string: text }, undefined)).toEqual(judgeWrite("advise", { file_path: "/r/a.py", content: text }, undefined));
  });

  test("only content and new_string are read, so a patch field judges nothing", () => {
    for (const field of ["patchText", "input", "patch", "command"]) {
      expect(judgeWrite("advise", { file_path: "/r/a.py", [field]: "+# AI-generated helper\n+x = 1" }, undefined)).toBeUndefined();
    }
  });

  test("an input with no file path judges nothing", () => {
    expect(judgeWrite("deny", { content: "# AI-generated helper\nx = 1" }, new Map())).toBeUndefined();
  });

  describe("the disable marker window", () => {
    const marker = "comment-gate-disable-file";
    const body = Array.from({ length: 4 }, () => "x = 1").join("\n");
    const slop = "# ----\nuser_name = input_value";

    test.each(["content", "new_string"])("a marker on line 5 of a %s passes, so a Write and an Edit read alike", (field) => {
      expect(judgeWrite("deny", { file_path: "/r/a.py", [field]: `${body}\n# ${marker}\n${slop}` }, new Map())).toBeUndefined();
    });

    test.each(["content", "new_string"])("a marker on line 6 of a %s is outside the window", (field) => {
      const input = { file_path: "/r/a.py", [field]: `${body}\nx = 2\n# ${marker}\n${slop}` };
      expect(judgeWrite("deny", input, new Map())?.kind).toBe("deny");
    });
  });

  test("a tool input that is not an object judges nothing", () => {
    expect(judgeWrite("deny", undefined, undefined)).toBeUndefined();
    expect(judgeWrite("deny", "# AI-generated helper", undefined)).toBeUndefined();
  });
});
