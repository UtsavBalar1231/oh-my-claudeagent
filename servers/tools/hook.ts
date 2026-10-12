import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { dispatch, isBlock, isDeny, type Output, payloadOf } from "../hooks/registry.ts";
import { projectRoot } from "../io.ts";
import type { Tool } from "../omca.ts";

const root = projectRoot(process.cwd());
const tracePath = process.env.OMCA_HOOK_TRACE === "1" ? join(root, ".omca", "state", "hook-trace.jsonl") : undefined;

function kind(output: Output): string {
  if (isDeny(output)) return "deny";
  if (isBlock(output)) return "block";
  if (output.hookSpecificOutput === undefined) return "empty";
  return output.hookSpecificOutput.hookEventName === "Stop" ? "continue" : "context";
}

export const tools: Tool[] = [
  {
    name: "omca_hook",
    description: "Internal: OMCA's settings hooks call this. Not for direct use.",
    inputSchema: {
      type: "object",
      properties: { event: { type: "string" } },
      required: ["event"],
      additionalProperties: { type: "string" },
    },
    annotations: { title: "OMCA hook entry point", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    call: async (args) => {
      const { event } = args;
      if (typeof event !== "string") throw new Error("omca_hook: event must be a string");
      const at = new Date().toISOString();
      const output = await dispatch(payloadOf({ ...args, event }), root);
      if (tracePath !== undefined) {
        const { session_id, agent_id, agent_type, tool_name } = args;
        const line = { at, event, session_id, agent_id, agent_type, tool_name, output: kind(output) };
        try {
          appendFileSync(tracePath, `${JSON.stringify(line)}\n`);
        } catch (error) {
          console.error(`omca: could not append to ${tracePath}:`, error);
        }
      }
      return JSON.stringify(output);
    },
  },
];
