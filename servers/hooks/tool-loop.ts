import { createHash } from "node:crypto";
import { isHookDisabled } from "../../src/core/kill-switch.ts";
import type { Handler } from "./registry.ts";

const LOOP_AT = 3;
const LOOP_NUDGE =
  "This exact set of tool calls has now run 3 times in a row with identical arguments. Repetition is a loop signal, not persistence: change the approach, vary the input, or escalate.";

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
const text = (value: unknown): string => (typeof value === "string" ? value : "");

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const members = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value);
}

// tool_response is left out: it is the result the model saw, which can differ between two
// attempts of the same batch.
const signatureOf = (calls: readonly unknown[]): string =>
  createHash("sha256")
    .update(canonical(calls.map((call) => ({ tool_name: field(call, "tool_name") ?? "", tool_input: field(call, "tool_input") ?? {} }))))
    .digest("hex");

export const handle: Handler = (payload, { session }) => {
  const calls = payload.tool_calls;
  if (session === undefined || !Array.isArray(calls) || calls.length === 0 || isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "tool-loop")) return;
  const windows = (session.toolLoopWindows ??= new Map());
  const agent = text(payload.agent_id);
  const signature = signatureOf(calls);
  const promptId = text(payload.prompt_id);
  const previous = windows.get(agent);
  const count = previous?.signature === signature && previous.promptId === promptId ? previous.count + 1 : 1;
  windows.set(agent, { signature, count, promptId });
  if (count === LOOP_AT) return { hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: LOOP_NUDGE } };
};
