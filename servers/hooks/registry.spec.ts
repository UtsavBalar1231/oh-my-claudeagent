import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch, type Handler, type Output, payloadOf, REGISTRY } from "./registry.ts";

const NOW = 1_786_000_000_000;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "omca-registry-"));
  roots.push(root);
  return root;
}

const context = (event: string, text: string): Handler => () => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
const answer = (output: Output): Handler => () => output;
const boom: Handler = () => {
  throw new Error("bad pattern");
};

function quietErrors() {
  return spyOn(console, "error").mockImplementation(() => {});
}

describe("registry", () => {
  test("lists every planned handler per event, in order", () => {
    const names = Object.fromEntries(Object.entries(REGISTRY).map(([event, handlers]) => [event, handlers.map(([name]) => name)]));
    expect(names).toEqual({
      PreToolUse: ["plan-write-guard", "comment-gate"],
      PermissionRequest: ["trusted-tooling"],
      PostToolUse: ["verification-recorder", "context-injector", "plan-format-warn", "empty-task-response"],
      PostToolUseFailure: ["failure-recovery"],
      UserPromptSubmit: ["guidance", "keyword-detector"],
      UserPromptExpansion: ["guidance", "slash-mode-detector"],
      SubagentStart: ["subagent-context"],
      PermissionDenied: ["permission-coach"],
      TaskCompleted: ["task-completed"],
      Stop: ["stop-gates"],
      SessionStart: ["session-start"],
    });
  });

  test("a payload no handler acts on answers {} on every event", async () => {
    const root = project();
    // Every subagent gets context, so no SubagentStart payload goes unanswered.
    const events = Object.keys(REGISTRY).filter((event) => event !== "SubagentStart");
    const answers = await Promise.all(events.map((event) => dispatch({ event, tool_name: "Read" }, root, NOW)));
    expect(answers).toEqual(events.map(() => ({})));
  });

  test("an unknown event answers {} and names the event on stderr", async () => {
    const errors = quietErrors();
    try {
      expect(await dispatch({ event: "Bogus" }, project(), NOW)).toEqual({});
      expect(errors.mock.calls).toEqual([['omca: omca_hook has no handlers for event "Bogus"']]);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("error isolation", () => {
  test("a throwing PreToolUse handler yields the deny JSON, which wins over context", async () => {
    const errors = quietErrors();
    try {
      const registry = { PreToolUse: [["ctx", context("PreToolUse", "a")], ["comment-gate", boom]] as const };
      expect(await dispatch({ event: "PreToolUse" }, project(), NOW, registry)).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "OMCA's comment-gate check failed, so this call is denied: bad pattern",
        },
      });
      expect(errors.mock.calls[0]?.[0]).toBe("omca: PreToolUse handler comment-gate failed:");
    } finally {
      errors.mockRestore();
    }
  });

  test("a throwing PermissionRequest handler yields {}, so the dialog shows and nothing is allowed", async () => {
    const errors = quietErrors();
    try {
      const registry = { PermissionRequest: [["trusted-tooling", boom]] as const };
      expect(await dispatch({ event: "PermissionRequest" }, project(), NOW, registry)).toEqual({});
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
    }
  });

  test("a throwing handler on any other event drops only its own answer and logs to stderr", async () => {
    const errors = quietErrors();
    try {
      const registry = {
        PostToolUse: [["a", context("PostToolUse", "first")], ["b", boom], ["c", context("PostToolUse", "second")]] as const,
      };
      expect(await dispatch({ event: "PostToolUse" }, project(), NOW, registry)).toEqual({
        hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "first\n\nsecond" },
      });
      expect(errors.mock.calls.map((call) => call[0])).toEqual(["omca: PostToolUse handler b failed:"]);
    } finally {
      errors.mockRestore();
    }
  });

  test("an async handler that rejects is isolated the same way", async () => {
    const errors = quietErrors();
    try {
      const rejects: Handler = async () => {
        throw new Error("late");
      };
      expect(await dispatch({ event: "Stop" }, project(), NOW, { Stop: [["stop-gates", rejects]] })).toEqual({});
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("answer precedence", () => {
  const deny = (reason: string): Output => ({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  });

  test("the first deny wins over context and over a later deny", async () => {
    const registry = {
      PreToolUse: [["a", context("PreToolUse", "x")], ["b", answer(deny("first"))], ["c", answer(deny("second"))]] as const,
    };
    expect(await dispatch({ event: "PreToolUse" }, project(), NOW, registry)).toEqual(deny("first"));
  });

  test("the first block wins over context and over a later block", async () => {
    const registry = {
      Stop: [
        ["a", context("Stop", "x")],
        ["b", answer({ decision: "block", reason: "first" })],
        ["c", answer({ decision: "block", reason: "second" })],
      ] as const,
    };
    expect(await dispatch({ event: "Stop" }, project(), NOW, registry)).toEqual({ decision: "block", reason: "first" });
  });

  test("context texts concatenate in handler order and every other field keeps the first answer", async () => {
    const registry = {
      PostToolUse: [
        ["a", answer({ hookSpecificOutput: { hookEventName: "PostToolUse", classifierContext: "note" } })],
        ["b", answer({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "one", classifierContext: "other" } })],
        ["c", answer({})],
        ["d", context("PostToolUse", "two")],
      ] as const,
    };
    expect(await dispatch({ event: "PostToolUse" }, project(), NOW, registry)).toEqual({
      hookSpecificOutput: { hookEventName: "PostToolUse", classifierContext: "note", additionalContext: "one\n\ntwo" },
    });
  });
});

describe("payloadOf", () => {
  test("decodes JSON-serialized object fields, keeps a raw string, and drops an empty path", () => {
    const payload = payloadOf({
      event: "PostToolUse",
      session_id: "s",
      tool_input: '{"command":"just test"}',
      tool_response: "some text",
      tool_calls: "",
      prompt: '{"looks":"like json"}',
    });
    expect(payload).toEqual({
      event: "PostToolUse",
      session_id: "s",
      tool_input: { command: "just test" },
      tool_response: "some text",
      tool_calls: undefined,
      prompt: '{"looks":"like json"}',
    });
  });
});
