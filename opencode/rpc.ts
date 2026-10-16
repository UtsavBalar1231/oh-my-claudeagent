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
          plan: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                properties: {
                  name: { type: "string" },
                  path: { type: "string" },
                  sha256: { type: "string" },
                  status: { type: "string" },
                  tasks: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        number: { type: "integer" },
                        label: { type: "string" },
                        checked: { type: "boolean" },
                        dependencies: { type: "array", items: { type: "integer" } },
                      },
                      required: ["number", "label", "checked", "dependencies"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["name", "path", "sha256", "status", "tasks"],
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
                    planSha: { type: "string" },
                  },
                  required: ["type", "command", "exitCode", "at", "snippet", "verifiedBy", "planSha"],
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
        required: ["sessionID", "directory", "plan", "evidence", "notepads", "health"],
        additionalProperties: false,
      },
    },
  },
  events: { updated: { schema: session } },
});
