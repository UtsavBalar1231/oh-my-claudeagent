import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatch, type Output, payloadOf } from "./registry.ts";

const NOW = 1_786_000_000_000;
const HOOKS = join(import.meta.dir, "..", "..", "hooks", "hooks.json");
const PLAN = "/home/user/.claude/plans/my-agent-abc123.md";

const denial = (path: string): Output => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: `[PLAN-CHECKBOX-VERIFY] Plan file ${path} has no numbered task checkbox. Write each task as \`- [ ] 1. <task>\`; plan progress and the Stop hooks count only numbered checkboxes.`,
  },
});

// No session id, so the dispatch writes no status file under the root.
const preToolUse = (tool: string, toolInput: unknown) =>
  dispatch(payloadOf({ event: "PreToolUse", session_id: "", tool_name: tool, tool_input: JSON.stringify(toolInput) }), "/nonexistent", NOW);

const savedDisabled = process.env.OMCA_DISABLED_HOOKS;

beforeEach(() => {
  delete process.env.OMCA_DISABLED_HOOKS;
});

afterEach(() => {
  if (savedDisabled === undefined) delete process.env.OMCA_DISABLED_HOOKS;
  else process.env.OMCA_DISABLED_HOOKS = savedDisabled;
});

test("a Write of a plan with no numbered checkbox is denied with the reason", async () => {
  const content = "# My Plan\n\n## TODOs\n\nno checkboxes here, just prose\n";
  expect(await preToolUse("Write", { file_path: PLAN, content })).toEqual(denial(PLAN));
});

test("a Write of a plan with numbered checkboxes is allowed", async () => {
  const content = "# My Plan\n\n## TODOs\n\n- [ ] 1. Task one\n";
  expect(await preToolUse("Write", { file_path: PLAN, content })).toEqual({});
});

test("an Edit whose new_string drops the checkboxes from a plan is denied", async () => {
  const input = { file_path: PLAN, old_string: "- [ ] 1. Old task", new_string: "## TODOs\n\nno checkboxes here anymore" };
  expect(await preToolUse("Edit", input)).toEqual(denial(PLAN));
});

test("a Write outside a plans directory is allowed", async () => {
  expect(await preToolUse("Write", { file_path: "/tmp/notes.md", content: "## TODOs\n\nno checkboxes" })).toEqual({});
});

test("a call that is not a Write or Edit is allowed", async () => {
  expect(await preToolUse("Read", { file_path: PLAN })).toEqual({});
});

test("a tool_input that is not an object is allowed", async () => {
  expect(await dispatch({ event: "PreToolUse", session_id: "", tool_name: "Write" }, "/nonexistent", NOW)).toEqual({});
});

test("plan-write-guard in OMCA_DISABLED_HOOKS turns the denial off", async () => {
  const input = { file_path: PLAN, content: "## TODOs\n\nno checkboxes" };
  expect(await preToolUse("Write", input)).toEqual(denial(PLAN));
  process.env.OMCA_DISABLED_HOOKS = "verification-recorder,plan-write-guard";
  expect(await preToolUse("Write", input)).toEqual({});
});

test("hooks.json routes every Write and Edit PreToolUse call to omca_hook in one group", () => {
  const groups = JSON.parse(readFileSync(HOOKS, "utf8")).hooks.PreToolUse;
  expect(groups).toEqual([
    {
      matcher: "Write|Edit",
      hooks: [
        {
          type: "mcp_tool",
          server: "plugin:oh-my-claudeagent:omca-hooks",
          tool: "omca_hook",
          timeout: 10,
          input: {
            event: "PreToolUse",
            session_id: "${session_id}",
            cwd: "${cwd}",
            tool_name: "${tool_name}",
            tool_input: "${tool_input}",
          },
        },
      ],
    },
  ]);
});
