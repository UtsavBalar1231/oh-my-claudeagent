import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatch, type Handler, payloadOf } from "./registry.ts";
import { handle } from "./trusted-tooling.ts";

const ALLOW = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
const HOOKS = join(import.meta.dir, "..", "..", "hooks", "hooks.json");

const CONTEXT = { root: "/nonexistent", now: 0, session: undefined };

// No session id, so the dispatch writes no status file under the root.
const permissionRequest = (command: string, registry?: Parameters<typeof dispatch>[3]) =>
  dispatch(
    payloadOf({ event: "PermissionRequest", session_id: "", tool_name: "Bash", tool_input: JSON.stringify({ command }) }),
    CONTEXT.root,
    CONTEXT.now,
    registry,
  );

test("npm run build is auto-allowed on PermissionRequest", async () => {
  expect(await permissionRequest("npm run build")).toEqual(ALLOW);
});

test("jq is auto-allowed on PermissionRequest", async () => {
  expect(await permissionRequest("jq . file.json")).toEqual(ALLOW);
});

test("git status gets no allow on PermissionRequest", async () => {
  expect(await permissionRequest("git status")).toEqual({});
});

test("a core.hooksPath rewrite is never auto-allowed", async () => {
  expect(await permissionRequest("git config --local core.hooksPath /tmp/evil")).toEqual({});
});

test("a compound npm command is declined even though it leads with npm test", async () => {
  expect(await permissionRequest("npm test && rm x")).toEqual({});
});

test("another tool's request, or a Bash request without a command, gets no answer", () => {
  expect(handle({ event: "PermissionRequest", tool_name: "Read", tool_input: { command: "npm test" } }, CONTEXT)).toBeUndefined();
  expect(handle({ event: "PermissionRequest", tool_name: "Bash", tool_input: undefined }, CONTEXT)).toBeUndefined();
  expect(handle({ event: "PermissionRequest", tool_name: "Bash", tool_input: "npm test" }, CONTEXT)).toBeUndefined();
});

test("a failing PermissionRequest handler answers nothing, so nothing is allowed", async () => {
  const boom: Handler = () => {
    throw new Error("boom");
  };
  const quiet = console.error;
  console.error = () => {};
  try {
    expect(await permissionRequest("npm test", { PermissionRequest: [["boom", boom]] })).toEqual({});
  } finally {
    console.error = quiet;
  }
});

test("hooks.json routes a Bash PermissionRequest to omca_hook", () => {
  const hooks = JSON.parse(readFileSync(HOOKS, "utf8")).hooks;
  const entries = hooks.PermissionRequest.filter((group: { matcher?: string }) => group.matcher === "Bash").flatMap(
    (group: { hooks: unknown[] }) => group.hooks,
  );
  expect(entries).toContainEqual({
    type: "mcp_tool",
    server: "plugin:oh-my-claudeagent:omca-hooks",
    tool: "omca_hook",
    timeout: 10,
    input: {
      event: "PermissionRequest",
      session_id: "${session_id}",
      tool_name: "${tool_name}",
      tool_input: "${tool_input}",
    },
  });
});
