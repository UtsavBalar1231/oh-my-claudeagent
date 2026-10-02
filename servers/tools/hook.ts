import type { Tool } from "../omca.ts";

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
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    call: (args) => {
      if (typeof args.event !== "string") throw new Error("omca_hook: event must be a string");
      return "{}";
    },
  },
];
