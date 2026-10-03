import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch, type Output, payloadOf } from "./registry.ts";
import { touchSession } from "./session-state.ts";

const NOW = 1_786_000_000_000;
const HEAD =
  "[COMMENT CHECK] Detected AI slop comment patterns. Remove the quoted comments with a follow-up Edit unless they encode a non-obvious why.";
const KEEP =
  "The convention: names, types, and structure carry the what, so a comment earns its place only by carrying something the code cannot state, the non-obvious why, an invariant, a constraint, or the derivation of a magic number. A correct fix deletes the quoted comment, or rewrites it as the reason the code is the way it is. A clearer name beats a comment that restates the line below it. Do NOT remove other comments while fixing this: file headers, non-obvious function contracts, invariant notes, and magic-number derivation comments may be required by the project's own convention. Resubmit the same code change with only the quoted comments fixed. Genuine exceptions: put @allow on a comment line to exempt that line from the slop checks, or put comment-gate-disable-file in the first 5 lines of the hunk.";

const ATTRIBUTION = "AI attribution comment detected.";
const AUTHORSHIP = "AI authorship comment detected.";
const PLACEHOLDER = "Unimplemented TODO placeholder detected.";
const restates = (text: string) => `Comment restates the following code line ("${text}"): delete it, or replace it with the non-obvious why.`;
const filler = (text: string) => `Filler-word comment ("${text}"): delete it.`;
const separator = (text: string) => `Decorative separator comment ("${text}"): delete it.`;
const bareTodo = (text: string) => `Context-free TODO/FIXME ("${text}"): add an issue ref or TODO(owner):.`;
const trivialDoc = (text: string) => `Doc comment adds nothing beyond the function name ("${text}"): delete it.`;

const advice = (...findings: string[]): Output => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: [HEAD, ...findings].join(" ") },
});
const blocked = (lead: string, ...findings: string[]): Output => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `${lead} ${findings.join(" ")} ${KEEP}` },
});
const blockedForAttribution = (...findings: string[]) => blocked("Blocked: AI-attribution or placeholder comment.", ...findings);
const blockedForSlop = (...findings: string[]) => blocked("Blocked: comment slop.", ...findings);

const ENV_NAMES = ["OMCA_COMMENT_GATE", "OMCA_DISABLED_HOOKS"] as const;
const savedEnv = ENV_NAMES.map((name) => [name, process.env[name]] as const);

let root: string;
let sessionId: string;
let errors: ReturnType<typeof spyOn>;

beforeEach(() => {
  for (const name of ENV_NAMES) delete process.env[name];
  root = mkdtempSync(join(tmpdir(), "omca-comment-gate-"));
  sessionId = crypto.randomUUID();
  errors = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  errors.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

const gate = (toolInput: Record<string, unknown>, tool = "Write") =>
  dispatch({ event: "PreToolUse", session_id: sessionId, tool_name: tool, tool_input: { file_path: "/repo/a.py", ...toolInput } }, root, NOW);
const write = (file_path: string, content: string) => gate({ file_path, content });
const inDenyMode = () => {
  process.env.OMCA_COMMENT_GATE = "deny";
};

describe("tier 1 and tier 2 findings in the default advise mode", () => {
  test("warns when content contains 'TODO: implement'", async () => {
    const content = "function foo() {\n  // TODO: implement this\n  return null;\n}";
    expect(await gate({ file_path: "/repo/a.js", content })).toEqual(advice(PLACEHOLDER, bareTodo("TODO: implement this")));
  });

  test("warns for Edit new_string content", async () => {
    const dirty = "function foo() {\n  // TODO: implement this\n  return null;\n}";
    expect(await gate({ file_path: "/repo/a.js", old_string: "", new_string: dirty }, "Edit")).toEqual(advice(PLACEHOLDER, bareTodo("TODO: implement this")));
  });

  test("no warning for clean Edit new_string content", async () => {
    expect(await gate({ old_string: "", new_string: "function foo() {\n  return 1;\n}" }, "Edit")).toEqual({});
  });

  test("warns on code-restating comment", async () => {
    const content = "# set user name to input value\nuser_name = input_value";
    expect(await gate({ content })).toEqual(advice(restates("set user name to input value")));
  });

  // Real narration carries a word the code line lacks, so a restating check that demanded zero
  // extra words only ever matched hand-built cases.
  test("warns on narrating comment that adds one word", async () => {
    expect(await gate({ content: "# Set the path attribute\nself.path = path" })).toEqual(advice(restates("Set the path attribute")));
  });

  test("warns on line-by-line narration via density", async () => {
    const content = [
      "# Define the configuration class",
      "class Config:",
      "    # Initialize the configuration",
      "    def __init__(self, path):",
      "        # Store the path",
      "        self.path = path",
      "        # Create an empty dict",
      "        self.values = {}",
      "    # Load the config file",
      "    def load(self):",
      "        # Open and parse it",
      "        return json.load(open(self.path))",
    ].join("\n");
    expect(await gate({ content })).toEqual(
      advice(
        restates("Store the path"),
        restates("Open and parse it"),
        "High comment density (6 comment lines to 6 code lines): likely line-by-line narration rather than documentation.",
      ),
    );
  });

  test("no warning for magic-number derivation comment", async () => {
    const content = "# 3600s (1h) - F1-F4 evidence freshness window. Sibling uses 300s; UNDOCUMENTED divergence.\nMAX_EVIDENCE_AGE_SECONDS=3600";
    expect(await gate({ content })).toEqual({});
  });

  test("no warning for terse magic-number comment", async () => {
    expect(await write("/tmp/x.sh", "# 300s evidence age\nMAX_EVIDENCE_AGE_SECONDS=300")).toEqual({});
  });

  test("no warning for invariant comment", async () => {
    const content = '# REQUIRES RALPH_STATE to be set upstream - see resolve_session_id above.\nif [[ -z "$RALPH_STATE" ]]; then\n  return 1\nfi';
    expect(await gate({ content })).toEqual({});
  });

  test("no warning when comment adds information code doesn't restate", async () => {
    expect(await gate({ content: "# cache the previous input value for diffing on next call\nuser_name = input_value" })).toEqual({});
  });

  test("warns on filler-word qualifier comment", async () => {
    expect(await gate({ content: "# obviously this handles the edge case\nfoo()" })).toEqual(advice(filler("obviously this handles the edge case")));
  });

  test("no warning for comment without filler qualifiers", async () => {
    expect(await gate({ content: "# handles the edge case for empty input\nfoo()" })).toEqual({});
  });

  test("a filler word inside a code span is a command name, not a qualifier", async () => {
    expect(await gate({ content: "# CI runs `just ci` on every push\nfoo()" })).toEqual({});
  });

  test("a filler word outside the code span still warns", async () => {
    expect(await gate({ content: "# just run `make` on every push\nfoo()" })).toEqual(advice(filler("just run `make` on every push")));
  });

  test("warns on decorative separator comment", async () => {
    expect(await gate({ content: "# ====================\nfoo()" })).toEqual(advice(separator("====================")));
  });

  test("no warning for a labeled section-banner comment", async () => {
    expect(await gate({ content: "# === Section: Setup ===\nfoo()" })).toEqual({});
  });

  test("warns on trivial doc comment above a one-line function", async () => {
    const content = "# returns the user id\ndef get_user_id():\n    return self.id\n";
    expect(await gate({ content })).toEqual(advice(restates("returns the user id"), trivialDoc("returns the user id")));
  });

  test("no warning for a doc comment that adds real information", async () => {
    const content = "# validates against the external billing service and retries on timeout\ndef get_user_id():\n    return self.id\n";
    expect(await gate({ content })).toEqual({});
  });

  test("warns on context-free TODO with no ref/owner/explanation", async () => {
    expect(await gate({ content: "# TODO fix this\nfoo()" })).toEqual(advice(bareTodo("TODO fix this")));
  });

  test("no warning for TODO carrying an issue reference", async () => {
    expect(await gate({ content: "# TODO(#123): fix this after upstream releases a patch\nfoo()" })).toEqual({});
  });

  test("@allow bypasses slop-pattern checks on that line", async () => {
    expect(await gate({ content: "# obviously simple @allow\nfoo()" })).toEqual({});
  });

  test("a disable-file marker in the first five lines exempts the whole write", async () => {
    const content = "# comment-gate-disable-file\n# obviously this is bad\nfoo()";
    expect(await gate({ content })).toEqual({});
  });

  test("a disable-file marker after the fifth line exempts nothing", async () => {
    const content = "a()\nb()\nc()\nd()\ne()\n# comment-gate-disable-file\n# obviously this is bad\nfoo()";
    expect(await gate({ content })).toEqual(advice(filler("obviously this is bad")));
  });
});

describe("what counts as a comment depends on the language", () => {
  test("shellcheck source directive is not a restatement", async () => {
    inDenyMode();
    const content = '# shellcheck source=lib/common.sh\nsource "$(dirname "$0")/lib/common.sh"';
    expect(await write("/repo/scripts/foo.sh", content)).toEqual({});
  });

  test("still denies a genuine restatement in a shell script", async () => {
    inDenyMode();
    expect(await write("/repo/scripts/foo.sh", '# set the user name\nuser_name="$input_value"')).toEqual(blockedForSlop(restates("set the user name")));
  });

  test("pragma keyword mid-comment is not exempt", async () => {
    inDenyMode();
    expect(await write("/repo/x.py", "# the path for noqa\nself.path = path")).toEqual(blockedForSlop(restates("the path for noqa")));
  });

  test("C preprocessor directives are not comments", async () => {
    inDenyMode();
    const content = '#include "pamir_ks_ta.h"\nstatic const char pamir_id[] = "x";';
    expect(await write("/repo/ta/pamir_ks_ta.c", content)).toEqual({});
  });

  test("still catches a restating // comment in C", async () => {
    inDenyMode();
    expect(await write("/repo/ta/x.c", "// set the user name\nuser_name = input_value;")).toEqual(blockedForSlop(restates("set the user name")));
  });

  test("reads -- as the comment marker in Lua", async () => {
    inDenyMode();
    expect(await write("/repo/x.lua", "-- set the user name\nuser_name = input_value")).toEqual(blockedForSlop(restates("set the user name")));
  });

  test("skips non-source files so Markdown headings are not comments", async () => {
    const content = "# Install dependencies\njust install\n\n# Run the tests\njust test\n\n# Build the plugin\njust build\n\n# Release a version\njust release\n\n# Clean the cache\njust clean\n\n# Lint the shell\njust lint";
    expect(await write("/tmp/README.md", content)).toEqual({});
  });

  test("a file under a tests directory is skipped", async () => {
    inDenyMode();
    expect(await write("/repo/tests/fixture.py", "# AI-generated helper\nx = 1")).toEqual({});
  });
});

describe("tier 1 only reads comment lines", () => {
  test("tier-1 denies an attribution comment behind a // marker", async () => {
    inDenyMode();
    expect(await write("/repo/ta/x.c", "// AI-generated helper\nint f(void) { return 1; }")).toEqual(blockedForAttribution(ATTRIBUTION));
  });

  test("tier-1 ignores an attribution phrase mid-comment", async () => {
    inDenyMode();
    expect(await write("/repo/ta/x.c", "// the gate below denies an ai-generated banner\nint f(void) { return 1; }")).toEqual({});
  });

  test("tier-1 ignores a banned string inside a grep pattern", async () => {
    inDenyMode();
    expect(await write("/repo/scripts/new-gate.sh", 'if grep -qi "# AI-generated" "$f"; then deny; fi')).toEqual({});
  });

  test("tier-1 ignores banned strings inside a list literal", async () => {
    inDenyMode();
    expect(await write("/repo/servers/fixtures.py", 'BANNED = ["TODO: implement", "# AI-generated"]')).toEqual({});
  });

  test("tier-1 still denies an attribution comment in the same file shape", async () => {
    inDenyMode();
    const content = '# AI-generated helper\nif grep -qi "x" "$f"; then deny; fi';
    expect(await write("/repo/scripts/new-gate.sh", content)).toEqual(blockedForAttribution(ATTRIBUTION));
  });

  test("tier-1 still denies a TODO placeholder comment", async () => {
    inDenyMode();
    expect(await write("/repo/servers/fixtures.py", "# TODO: implement\ndef f():\n    pass")).toEqual(blockedForAttribution(PLACEHOLDER));
  });

  test("a TODO placeholder carrying an issue reference is not a placeholder", async () => {
    inDenyMode();
    expect(await write("/repo/servers/fixtures.py", "# TODO: implement #42\ndef f():\n    pass")).toEqual({});
  });
});

describe("enforcement level", () => {
  test("advise mode reports a tier-1 comment but never denies", async () => {
    process.env.OMCA_COMMENT_GATE = "advise";
    expect(await write("/tmp/x.sh", "# This code was written by an assistant\nfoo() { :; }")).toEqual(advice(AUTHORSHIP));
  });

  test("advise mode stays silent on a banned string in a literal", async () => {
    process.env.OMCA_COMMENT_GATE = "advise";
    expect(await write("/repo/servers/fixtures.py", 'BANNED = ["# This code was written by"]')).toEqual({});
  });

  test("advise mode emits context and never denies", async () => {
    process.env.OMCA_COMMENT_GATE = "advise";
    expect(await write("/tmp/x.sh", "# AI-generated helper\nfoo() { :; }")).toEqual(advice(ATTRIBUTION));
  });

  test("a value other than off or deny advises", async () => {
    process.env.OMCA_COMMENT_GATE = "strict";
    expect(await write("/tmp/x.sh", "# AI-generated helper\nfoo() { :; }")).toEqual(advice(ATTRIBUTION));
  });

  test("advise mode names the tier it would have denied on the server log", async () => {
    await write("/tmp/x.sh", "# AI-generated helper\nfoo() { :; }");
    await write("/tmp/x.sh", "# obviously this handles the edge case\nfoo");
    await write("/tmp/x.sh", "# === Section ===\nfoo");
    expect(errors.mock.calls).toEqual([
      ["omca: comment-gate would deny (tier1) /tmp/x.sh"],
      ["omca: comment-gate would deny (tier2) /tmp/x.sh"],
    ]);
  });

  test("deny mode blocks tier-1 literal patterns", async () => {
    inDenyMode();
    expect(await write("/tmp/x.sh", "# AI-generated helper\nfoo() { :; }")).toEqual(blockedForAttribution(ATTRIBUTION));
  });

  test("a tier-3 finding alone only advises, even in deny mode", async () => {
    inDenyMode();
    const content = "// a\n// b\n// c\n// d\n// e\n// f\nfoo();";
    expect(await write("/repo/x.ts", content)).toEqual(
      advice(
        "Excessive consecutive comment lines (6 in a row) detected.",
        "High comment density (6 comment lines to 1 code lines): likely line-by-line narration rather than documentation.",
      ),
    );
  });

  test("gate off exits silently", async () => {
    process.env.OMCA_COMMENT_GATE = "off";
    expect(await write("/tmp/x.sh", "# AI-generated helper\nfoo() { :; }")).toEqual({});
  });

  test("OMCA_DISABLED_HOOKS bypasses detection entirely", async () => {
    inDenyMode();
    const content = "# AI-generated code\ndef foo():\n    pass";
    expect(await write("/tmp/x.py", content)).toEqual(blockedForAttribution(ATTRIBUTION));
    process.env.OMCA_DISABLED_HOOKS = "comment-gate";
    expect(await write("/tmp/x.py", content)).toEqual({});
  });
});

describe("a tier-2 denial is given once per file and finding", () => {
  const slop = "# set the user name\nuser_name = input_value";
  const sentence = restates("set the user name");

  test("the first denial blocks, the identical retry passes with advice, and the third blocks again", async () => {
    inDenyMode();
    expect(await write("/repo/a.py", slop)).toEqual(blockedForSlop(sentence));
    expect(await write("/repo/a.py", slop)).toEqual(advice(sentence));
    expect(await write("/repo/a.py", slop)).toEqual(blockedForSlop(sentence));
  });

  test("two files written in turn each get their own retry", async () => {
    inDenyMode();
    expect(await write("/repo/a.py", slop)).toEqual(blockedForSlop(sentence));
    expect(await write("/repo/b.py", slop)).toEqual(blockedForSlop(sentence));
    expect(await write("/repo/a.py", slop)).toEqual(advice(sentence));
    expect(await write("/repo/b.py", slop)).toEqual(advice(sentence));
  });

  test("the same finding in another file is denied", async () => {
    inDenyMode();
    expect(await write("/repo/a.py", slop)).toEqual(blockedForSlop(sentence));
    expect(await write("/repo/b.py", slop)).toEqual(blockedForSlop(sentence));
  });

  test("another finding in the same file is denied", async () => {
    inDenyMode();
    expect(await write("/repo/a.py", slop)).toEqual(blockedForSlop(sentence));
    expect(await write("/repo/a.py", "# set the path name\npath_name = input_value")).toEqual(blockedForSlop(restates("set the path name")));
  });

  test("a retry in another session is denied again", async () => {
    inDenyMode();
    expect(await write("/repo/a.py", slop)).toEqual(blockedForSlop(sentence));
    sessionId = crypto.randomUUID();
    expect(await write("/repo/a.py", slop)).toEqual(blockedForSlop(sentence));
  });

  test("a tier-1 denial is never given once", async () => {
    inDenyMode();
    const content = "# AI-generated helper\nuser_name = input_value";
    expect(await write("/repo/a.py", content)).toEqual(blockedForAttribution(ATTRIBUTION));
    expect(await write("/repo/a.py", content)).toEqual(blockedForAttribution(ATTRIBUTION));
  });

  test("a call that names no session cannot remember a denial, so it advises", async () => {
    inDenyMode();
    const call = () => dispatch({ event: "PreToolUse", session_id: "", tool_name: "Write", tool_input: { file_path: "/repo/a.py", content: slop } }, root, NOW);
    expect(await call()).toEqual(advice(sentence));
    expect(await call()).toEqual(advice(sentence));
  });
});

describe("other calls and failures", () => {
  test("the gate's own source passes its own checks", async () => {
    inDenyMode();
    for (const path of [join(import.meta.dir, "comment-gate.ts"), join(import.meta.dir, "..", "..", "src", "core", "comments.ts")]) {
      expect(await write(path, readFileSync(path, "utf8"))).toEqual({});
    }
  });

  test("a call of another tool is ignored", async () => {
    inDenyMode();
    expect(await gate({ file_path: "/repo/a.py", content: "# AI-generated helper\nx = 1" }, "Read")).toEqual({});
  });

  test("a serialized tool_input is decoded before the content is read", async () => {
    inDenyMode();
    const toolInput = JSON.stringify({ file_path: "/repo/a.py", content: '# AI-generated "helper"\nx = 1\n' });
    const payload = payloadOf({ event: "PreToolUse", session_id: sessionId, tool_name: "Write", tool_input: toolInput });
    expect(await dispatch(payload, root, NOW)).toEqual(blockedForAttribution(ATTRIBUTION));
  });

  test("a failure inside the gate fails open: the write passes and the registry logs it", async () => {
    inDenyMode();
    const session = touchSession(sessionId);
    Object.defineProperty(session, "commentGate", {
      get() {
        throw new Error("state is unreadable");
      },
    });
    expect(await write("/repo/a.py", "# AI-generated helper\nx = 1")).toEqual({});
    expect(errors.mock.calls[0]?.[0]).toBe("omca: PreToolUse handler comment-gate failed:");
    expect(String(errors.mock.calls[0]?.[1])).toContain("state is unreadable");
  });
});

describe("recorded Write payloads", () => {
  test("an AI-generated header in a Python write is advised", async () => {
    expect(await write("/project/src/main.py", "# AI-generated code\ndef foo():\n    pass")).toEqual(advice(ATTRIBUTION));
  });

  test("clean Python code passes", async () => {
    expect(await write("/project/src/main.py", "def foo():\n    return 42")).toEqual({});
  });
});
