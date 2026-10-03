import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  test("lists every handler per event, in order", () => {
    const names = Object.fromEntries(Object.entries(REGISTRY).map(([event, handlers]) => [event, handlers.map(([name]) => name)]));
    expect(names).toEqual({
      PreToolUse: ["plan-write-guard", "comment-gate"],
      PostToolUse: ["verification-recorder", "context-injector", "plan-format-warn", "empty-task-response"],
      PostToolUseFailure: ["failure-recovery"],
      UserPromptSubmit: ["mod-notice", "guidance", "keyword-detector"],
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

describe("hooks.json against the registry", () => {
  type Entry = { matcher?: string; hooks: { input: Record<string, string> }[] };
  const HOOKS: Record<string, Entry[]> = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "hooks", "hooks.json"), "utf8")).hooks;

  // The payload fields each event's handlers read, beside the event and the session id that every entry passes.
  const READS: Record<string, readonly string[]> = {
    PreToolUse: ["tool_name", "tool_input"],
    PostToolUse: ["agent_id", "agent_type", "tool_name", "tool_input", "tool_response"],
    PostToolUseFailure: ["tool_name", "tool_input", "error", "duration_ms"],
    UserPromptSubmit: ["agent_id", "prompt", "session_title"],
    UserPromptExpansion: ["command_name"],
    SubagentStart: ["agent_type"],
    PermissionDenied: ["tool_name", "reason"],
    TaskCompleted: [],
    Stop: ["transcript_path", "stop_hook_active", "last_assistant_message", "background_tasks"],
    SessionStart: ["source"],
  };

  test("hooks.json registers exactly the registry's events, and the table covers each one", () => {
    expect(Object.keys(HOOKS).toSorted()).toEqual(Object.keys(REGISTRY).toSorted());
    expect(Object.keys(READS).toSorted()).toEqual(Object.keys(REGISTRY).toSorted());
  });

  test("every entry passes its event, the session id and each field its handlers read, substituted from the payload", () => {
    for (const [event, entries] of Object.entries(HOOKS)) {
      const expected = { event, ...Object.fromEntries(["session_id", ...(READS[event] ?? [])].map((field) => [field, `\${${field}}`])) };
      for (const { hooks } of entries) for (const { input } of hooks) expect({ event, input }).toMatchObject({ event, input: expected });
    }
  });
});

describe("event names that exist on every object", () => {
  test.each(["constructor", "__proto__", "toString", "hasOwnProperty"])("%s has no handlers, answers {} and is named on stderr", async (event) => {
    const errors = quietErrors();
    try {
      expect(await dispatch({ event }, project(), NOW)).toEqual({});
      expect(errors.mock.calls).toEqual([[`omca: omca_hook has no handlers for event ${JSON.stringify(event)}`]]);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("error isolation", () => {
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

describe("system messages", () => {
  test("system messages concatenate in handler order beside the context", async () => {
    const registry = {
      UserPromptSubmit: [
        ["a", answer({ systemMessage: "one" })],
        ["b", context("UserPromptSubmit", "note")],
        ["c", answer({ systemMessage: "two" })],
      ] as const,
    };
    expect(await dispatch({ event: "UserPromptSubmit" }, project(), NOW, registry)).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "note" },
      systemMessage: "one\n\ntwo",
    });
  });

  test("a system message survives a block", async () => {
    const registry = {
      Stop: [["a", answer({ systemMessage: "heads up" })], ["b", answer({ decision: "block", reason: "no" })]] as const,
    };
    expect(await dispatch({ event: "Stop" }, project(), NOW, registry)).toEqual({ decision: "block", reason: "no", systemMessage: "heads up" });
  });
});

describe("payloadOf", () => {
  test("decodes JSON-serialized object fields, keeps a raw string, and drops an empty path", () => {
    const payload = payloadOf({
      event: "PostToolUse",
      session_id: "s",
      tool_input: '{"command":"just test"}',
      tool_response: "some text",
      background_tasks: "",
      prompt: '{"looks":"like json"}',
    });
    expect(payload).toEqual({
      event: "PostToolUse",
      session_id: "s",
      tool_input: { command: "just test" },
      tool_response: "some text",
      background_tasks: undefined,
      prompt: '{"looks":"like json"}',
    });
  });

  test("an object field that arrives already decoded passes through unchanged", () => {
    const payload = payloadOf({ event: "Stop", background_tasks: [{ id: "t1", type: "shell" }], tool_input: { command: "x" } });
    expect(payload).toMatchObject({ background_tasks: [{ id: "t1", type: "shell" }], tool_input: { command: "x" } });
  });
});
