import { Rpc } from "@opencode/plugin/rpc";

export type { Snapshot } from "./state.ts";

const session = {
  type: "object",
  properties: { sessionID: { type: "string", minLength: 1 } },
  required: ["sessionID"],
  additionalProperties: false,
} as const;

export const Omca = Rpc.define({
  id: "omca",
  methods: {
    snapshot: {
      input: session,
      output: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          directory: { type: "string" },
          run: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                properties: {
                  name: { type: "string" },
                  tasks: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        subject: { type: "string" },
                        description: { type: "string" },
                        activeForm: { type: "string" },
                        status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                        owner: { type: "string" },
                        blocks: { type: "array", items: { type: "string" } },
                        blockedBy: { type: "array", items: { type: "string" } },
                        run: { type: "string" },
                        isFinal: { type: "boolean" },
                        blockedReason: { type: "string" },
                        details: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: { name: { type: "string" }, text: { type: "string" } },
                            required: ["name", "text"],
                            additionalProperties: false,
                          },
                        },
                      },
                      required: ["id", "subject", "description", "activeForm", "status", "owner", "blocks", "blockedBy", "run", "isFinal", "blockedReason", "details"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["name", "tasks"],
                additionalProperties: false,
              },
            ],
          },
          evidence: {
            type: "object",
            properties: {
              verdict: { type: "string", enum: ["missing", "historical", "stale", "verified"] },
              entries: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    type: { type: "string" },
                    command: { type: "string" },
                    exitCode: { type: "integer" },
                    at: { type: "number" },
                    snippet: { type: "string" },
                    verifiedBy: { type: ["string", "null"] },
                    taskId: { type: "string" },
                    tree: { type: "string" },
                  },
                  required: ["type", "command", "exitCode", "at", "snippet", "verifiedBy", "taskId", "tree"],
                  additionalProperties: false,
                },
              },
            },
            required: ["entries", "verdict"],
            additionalProperties: false,
          },
          notepads: {
            type: "array",
            items: {
              type: "object",
              properties: { section: { type: "string" }, content: { type: "string" } },
              required: ["section", "content"],
              additionalProperties: false,
            },
          },
          health: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                state: { type: "string", enum: ["ok", "warning", "error"] },
                detail: { type: "string" },
              },
              required: ["name", "state", "detail"],
              additionalProperties: false,
            },
          },
        },
        required: ["sessionID", "directory", "run", "evidence", "notepads", "health"],
        additionalProperties: false,
      },
    },
  },
  events: { updated: { schema: session } },
});
