import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch, payloadOf } from "./registry.ts";
import { findSession } from "./session-state.ts";

const NOW = 1_786_000_000_000;
const HOOKS = join(import.meta.dir, "..", "..", "hooks", "hooks.json");
const NUDGE =
  "This exact set of tool calls has now run 3 times in a row with identical arguments. Repetition is a loop signal, not persistence: change the approach, vary the input, or escalate.";

const READ_A = [{ tool_name: "Read", tool_input: { file_path: "/a" }, tool_use_id: "t1", tool_response: "1\tone" }];
const READ_B = [{ tool_name: "Read", tool_input: { file_path: "/b" }, tool_use_id: "t2", tool_response: "1\ttwo" }];
const READ_AB = [{ tool_name: "Read", tool_input: { file_path: "/a" } }, { tool_name: "Read", tool_input: { file_path: "/b" } }];

const roots: string[] = [];

afterEach(() => {
  delete process.env.OMCA_DISABLED_HOOKS;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Batch = (calls: unknown, extra?: Record<string, unknown>) => Promise<string | undefined>;

function session(sessionId: string = crypto.randomUUID()): { sessionId: string; batch: Batch } {
  const root = mkdtempSync(join(tmpdir(), "omca-loop-"));
  roots.push(root);
  return {
    sessionId,
    batch: async (calls, extra = {}) => {
      const output = await dispatch({ event: "PostToolBatch", session_id: sessionId, tool_calls: calls, ...extra }, root, NOW);
      if (output.hookSpecificOutput === undefined) return undefined;
      expect(output.hookSpecificOutput.hookEventName).toBe("PostToolBatch");
      return output.hookSpecificOutput.additionalContext as string;
    },
  };
}

async function run(batch: Batch, sequence: readonly (readonly [unknown, Record<string, unknown>?])[]): Promise<(string | undefined)[]> {
  const answers: (string | undefined)[] = [];
  for (const [calls, extra] of sequence) answers.push(await batch(calls, extra));
  return answers;
}

describe("one agent's streak", () => {
  test("tool-loop-batch: 3 identical batches emit the advisory only on the third", async () => {
    expect(await run(session().batch, [[READ_AB], [READ_AB], [READ_AB], [READ_AB]])).toEqual([undefined, undefined, NUDGE, undefined]);
  });

  test("a streak that has nudged nudges again at the third batch of the next streak", async () => {
    expect(await run(session().batch, [[READ_A], [READ_A], [READ_A], [READ_B], [READ_B], [READ_B]])).toEqual([undefined, undefined, NUDGE, undefined, undefined, NUDGE]);
  });

  test("tool-loop-batch: a differing batch mid-streak resets the count", async () => {
    expect(await run(session().batch, [[READ_A], [READ_A], [READ_B], [READ_A], [READ_A], [READ_A]])).toEqual([undefined, undefined, undefined, undefined, undefined, NUDGE]);
  });

  test("tool-loop-batch: a batch differing only in membership is a different signature", async () => {
    expect(await run(session().batch, [[READ_A], [READ_A], [READ_AB], [READ_AB], [READ_AB]])).toEqual([undefined, undefined, undefined, undefined, NUDGE]);
  });

  test("tool-loop-batch: identical tool_input under a different tool name is a different signature", async () => {
    const asBash = [{ tool_name: "Bash", tool_input: { command: "ls foo" } }];
    const asEdit = [{ tool_name: "Edit", tool_input: { command: "ls foo" } }];
    expect(await run(session().batch, [[asBash], [asBash], [asEdit], [asEdit], [asEdit]])).toEqual([undefined, undefined, undefined, undefined, NUDGE]);
  });

  test("tool-loop-batch: differing tool_response does not break a streak", async () => {
    const first = [{ tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "a\n" }];
    const second = [{ tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "b\n" }];
    expect(await run(session().batch, [[first], [second], [first]])).toEqual([undefined, undefined, NUDGE]);
  });

  test("key order in tool_input does not change the signature, at any depth", async () => {
    const one = [{ tool_name: "Task", tool_input: { a: 1, b: { c: 2, d: [{ e: 3, f: 4 }] } } }];
    const two = [{ tool_name: "Task", tool_input: { b: { d: [{ f: 4, e: 3 }], c: 2 }, a: 1 } }];
    expect(await run(session().batch, [[one], [two], [one]])).toEqual([undefined, undefined, NUDGE]);
  });

  test("a call without tool_input signs the same as one with an empty object", async () => {
    expect(await run(session().batch, [[[{ tool_name: "Read" }]], [[{ tool_name: "Read", tool_input: {} }]], [[{ tool_name: "Read" }]]])).toEqual([undefined, undefined, NUDGE]);
  });

  test("tool-loop-batch: a new prompt_id resets the streak", async () => {
    const turnOne = { prompt_id: "p1" };
    const turnTwo = { prompt_id: "p2" };
    expect(await run(session().batch, [[READ_A, turnOne], [READ_A, turnOne], [READ_A, turnTwo], [READ_A, turnTwo], [READ_A, turnTwo]])).toEqual([undefined, undefined, undefined, undefined, NUDGE]);
  });

  test("tool-loop-batch: an empty batch writes no state and stays silent", async () => {
    const { batch, sessionId } = session();
    expect(await batch([])).toBeUndefined();
    expect(findSession(sessionId)?.toolLoopWindows).toBeUndefined();
  });

  test("an empty batch between two identical batches leaves the streak intact", async () => {
    expect(await run(session().batch, [[READ_A], [[]], [READ_A], [READ_A]])).toEqual([undefined, undefined, undefined, NUDGE]);
  });

  test("a tool_calls value that is not an array stays silent", async () => {
    const { batch, sessionId } = session();
    expect(await run(batch, [["not json{{{"], [{ tool_name: "Read" }], [undefined]])).toEqual([undefined, undefined, undefined]);
    expect(findSession(sessionId)?.toolLoopWindows).toBeUndefined();
  });

  test("the serialized tool_calls of a real entry decode into the same signature as an object", async () => {
    const root = mkdtempSync(join(tmpdir(), "omca-loop-"));
    roots.push(root);
    const sessionId = crypto.randomUUID();
    const answers: (string | undefined)[] = [];
    for (const calls of [JSON.stringify(READ_A), JSON.stringify(READ_A), JSON.stringify(READ_A)]) {
      const wire = payloadOf({ event: "PostToolBatch", session_id: sessionId, agent_id: "", tool_calls: calls });
      answers.push((await dispatch(wire, root, NOW)).hookSpecificOutput?.additionalContext as string | undefined);
    }
    expect(answers).toEqual([undefined, undefined, NUDGE]);
  });
});

describe("agents and sessions do not share a streak", () => {
  test("two agents with identical batches do not combine into one streak", async () => {
    expect(
      await run(session().batch, [
        [READ_A, { agent_id: "a1" }],
        [READ_A, { agent_id: "a2" }],
        [READ_A, { agent_id: "a1" }],
        [READ_A, { agent_id: "a2" }],
        [READ_A, { agent_id: "a1" }],
      ]),
    ).toEqual([undefined, undefined, undefined, undefined, NUDGE]);
  });

  test("the main thread and two subagents each reach their own third batch", async () => {
    const sequence = ["", "a1", "a2", "", "a1", "a2", "", "a1", "a2"].map((agent_id) => [READ_A, { agent_id }] as const);
    expect(await run(session().batch, sequence)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, NUDGE, NUDGE, NUDGE]);
  });

  test("another agent's different batch does not reset a streak", async () => {
    expect(
      await run(session().batch, [
        [READ_A, { agent_id: "a1" }],
        [READ_B, { agent_id: "a2" }],
        [READ_A, { agent_id: "a1" }],
        [READ_B, { agent_id: "a2" }],
        [READ_A, { agent_id: "a1" }],
      ]),
    ).toEqual([undefined, undefined, undefined, undefined, NUDGE]);
  });

  test("a subagent's batches do not extend the main thread's streak", async () => {
    expect(await run(session().batch, [[READ_A], [READ_A, { agent_id: "a1" }], [READ_A]])).toEqual([undefined, undefined, undefined]);
  });

  test("two sessions keep separate streaks", async () => {
    const first = session();
    const second = session();
    expect(await run(first.batch, [[READ_A], [READ_A]])).toEqual([undefined, undefined]);
    expect(await second.batch(READ_A)).toBeUndefined();
    expect(await first.batch(READ_A)).toBe(NUDGE);
  });

  test("a call without a session id keeps no streak", async () => {
    expect(await run(session("").batch, [[READ_A], [READ_A], [READ_A]])).toEqual([undefined, undefined, undefined]);
  });
});

describe("kill switch", () => {
  test("tool-loop-batch: OMCA_DISABLED_HOOKS bypasses detection entirely", async () => {
    process.env.OMCA_DISABLED_HOOKS = "tool-loop";
    const { batch, sessionId } = session();
    expect(await run(batch, [[READ_A], [READ_A], [READ_A]])).toEqual([undefined, undefined, undefined]);
    expect(findSession(sessionId)?.toolLoopWindows).toBeUndefined();
  });

  test("naming another hook leaves detection on", async () => {
    process.env.OMCA_DISABLED_HOOKS = "failure-recovery";
    expect(await run(session().batch, [[READ_A], [READ_A], [READ_A]])).toEqual([undefined, undefined, NUDGE]);
  });
});

test("hooks.json routes every PostToolBatch to omca_hook through one entry carrying the agent and prompt ids", () => {
  expect(JSON.parse(readFileSync(HOOKS, "utf8")).hooks.PostToolBatch).toEqual([
    {
      hooks: [
        {
          type: "mcp_tool",
          server: "plugin:oh-my-claudeagent:omca-hooks",
          tool: "omca_hook",
          timeout: 10,
          input: {
            event: "PostToolBatch",
            session_id: "${session_id}",
            agent_id: "${agent_id}",
            prompt_id: "${prompt_id}",
            tool_calls: "${tool_calls}",
          },
        },
      ],
    },
  ]);
});
