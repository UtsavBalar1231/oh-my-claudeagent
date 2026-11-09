import { describe, expect, test } from "bun:test";
import { offeredTools, smokeScript, taskRunScript, toolResults } from "./ci-smoke.ts";
import { guardDenies, hookCalls, pluginDenies } from "./lib.ts";

const REASON = "Destructive rm -rf blocked: the target is the filesystem root, home, the working directory, or a directory directly under root or home. Name a deeper path explicitly.";
const BASH_DENY = `2026-10-02T21:20:39.671Z [DEBUG] tool.check Bash toolu_mock_1: unevaluated -> deny by plugin oh-my-claudeagent: ${REASON}`;
const POWERSHELL_DENY = `2026-10-02T21:20:39.700Z [DEBUG] tool.check PowerShell toolu_mock_2: unevaluated -> deny by plugin oh-my-claudeagent: ${REASON}`;
const LISTED_DENY = `2026-11-03T09:13:07.569Z [DEBUG] tool.check Bash toolu_mock_1: unevaluated -> deny by plugins oh-my-claudeagent, cc-plugin-privacy: ${REASON}`;
const HOOK_LINE = "2026-10-02T21:20:39.628Z [DEBUG] Hooks: mcp_tool calling plugin:oh-my-claudeagent:omca/omca_hook with 6 arg(s)";
const NOISE = "2026-10-02T21:20:39.671Z [DEBUG] hooks module oh-my-claudeagent@inline tool.check settled in 1.2ms (worker hop, next() included)";

describe("hookCalls", () => {
  test("counts each omca_hook mcp_tool call and ignores other hook lines", () => {
    expect(hookCalls([HOOK_LINE, NOISE, HOOK_LINE].join("\n"))).toBe(2);
    expect(hookCalls(NOISE)).toBe(0);
    expect(hookCalls("")).toBe(0);
  });
});

describe("guardDenies", () => {
  const debug = [NOISE, BASH_DENY, POWERSHELL_DENY].join("\n");

  test("matches the deny line of the named tool only", () => {
    expect(guardDenies(debug, "Bash")).toEqual([BASH_DENY]);
    expect(guardDenies(debug, "PowerShell")).toEqual([POWERSHELL_DENY]);
  });

  test("reads a debug file with CRLF line endings", () => {
    expect(guardDenies([BASH_DENY, NOISE].join("\r\n"), "Bash")).toEqual([BASH_DENY]);
  });

  test("ignores a deny for another reason", () => {
    const other = BASH_DENY.replace("Destructive rm -rf blocked", "Destructive git command blocked");
    expect(guardDenies(other, "Bash")).toEqual([]);
  });

  test("matches a deny line that lists other plugins beside this one", () => {
    expect(guardDenies(LISTED_DENY, "Bash")).toEqual([LISTED_DENY]);
    expect(guardDenies(LISTED_DENY.replace("plugins oh-my-claudeagent, cc-plugin-privacy", "plugins cc-plugin-privacy, oh-my-claudeagent"), "Bash")).toHaveLength(1);
  });
});

describe("pluginDenies", () => {
  test("counts every deny by the plugin whatever the tool or reason", () => {
    const other = BASH_DENY.replace("Destructive rm -rf blocked", "Destructive git command blocked");
    expect(pluginDenies([BASH_DENY, POWERSHELL_DENY, other, NOISE].join("\n"))).toHaveLength(3);
    expect(pluginDenies(NOISE)).toEqual([]);
  });

  test("counts a deny that lists other plugins and ignores one this plugin is not named in", () => {
    expect(pluginDenies(LISTED_DENY)).toEqual([LISTED_DENY]);
    expect(pluginDenies(LISTED_DENY.replace("oh-my-claudeagent, ", ""))).toEqual([]);
    expect(pluginDenies(BASH_DENY.replace("oh-my-claudeagent", "oh-my-claudeagent-extra"))).toEqual([]);
  });
});

describe("offeredTools", () => {
  const stream = (init: object) => [JSON.stringify({ type: "system", subtype: "hook_started" }), JSON.stringify(init), JSON.stringify({ type: "result" })].join("\n");

  test("lists the tools of the system init message", () => {
    expect(offeredTools(stream({ type: "system", subtype: "init", tools: ["Bash", "PowerShell"] }))).toEqual(["Bash", "PowerShell"]);
  });

  test("reads an empty list when there is no init message or it has no tools", () => {
    expect(offeredTools(stream({ type: "system", subtype: "status" }))).toEqual([]);
    expect(offeredTools(stream({ type: "system", subtype: "init" }))).toEqual([]);
    expect(offeredTools("")).toEqual([]);
  });
});

describe("smokeScript", () => {
  test("ends every script with a Bash recursive removal and a closing reply", () => {
    for (const withPowerShell of [false, true]) {
      const { main } = smokeScript(withPowerShell);
      const names = main.map((turn) => turn.content.map((block) => (block.type === "tool_use" ? block.name : "text")).join());
      expect(names).toEqual(withPowerShell ? ["PowerShell", "Bash", "text"] : ["Bash", "text"]);
    }
  });

  test("scripts the PowerShell removal at a target that does not exist", () => {
    const first = smokeScript(true).main[0]?.content[0];
    expect(first?.type === "tool_use" ? first.input.command : undefined).toBe("Remove-Item -Recurse -Force C:\\omca-ci-smoke-no-such-dir");
  });
});

describe("taskRunScript", () => {
  const calls = taskRunScript("/config/tasks/omca-project-12345678/1.json").main.map((turn) => turn.content.map((block) => (block.type === "tool_use" ? [block.name, block.input] : ["text", block.text])));

  test("creates the final task, reads its file and the server's list, then completes it around the verdict", () => {
    expect(calls).toEqual([
      [["TaskCreate", { subject: "Review the smoke run", description: "Review the smoke run and record its verdict.", activeForm: "Reviewing the smoke run", metadata: { run: "ci-smoke-run", final: true } }]],
      [["Read", { file_path: "/config/tasks/omca-project-12345678/1.json" }]],
      [["mcp__plugin_oh-my-claudeagent_omca__task_list", {}]],
      [["TaskUpdate", { taskId: "1", status: "completed" }]],
      [["mcp__plugin_oh-my-claudeagent_omca__evidence_log", { evidence_type: "final_verification", command: "ci smoke task run", exit_code: 0, output_snippet: "COMPLETE", task_id: "1" }]],
      [["TaskUpdate", { taskId: "1", status: "completed" }]],
      [["text", "done"]],
    ]);
  });
});

describe("toolResults", () => {
  const assistant = (...content: object[]) => JSON.stringify({ type: "assistant", message: { content } });
  const user = (...content: object[]) => JSON.stringify({ type: "user", message: { content } });

  test("names each result by the tool_use it answers, reading string and block content and the error flag", () => {
    const stream = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["TaskCreate"] }),
      assistant({ type: "tool_use", id: "toolu_mock_1", name: "TaskCreate", input: {} }),
      user({ type: "tool_result", tool_use_id: "toolu_mock_1", content: "Task #1 created successfully: Review the smoke run" }),
      assistant({ type: "text", text: "next" }, { type: "tool_use", id: "toolu_mock_2", name: "mcp__plugin_oh-my-claudeagent_omca__task_list", input: {} }),
      user({ type: "tool_result", tool_use_id: "toolu_mock_2", content: [{ type: "text", text: "Run ci-smoke-run:" }, { type: "text", text: "#1 [pending] Review the smoke run [final]" }] }),
      user({ type: "tool_result", tool_use_id: "toolu_mock_9", content: "orphan", is_error: true }),
      JSON.stringify({ type: "result" }),
    ].join("\n");
    expect(toolResults(stream)).toEqual([
      { name: "TaskCreate", text: "Task #1 created successfully: Review the smoke run", isError: false },
      { name: "mcp__plugin_oh-my-claudeagent_omca__task_list", text: "Run ci-smoke-run:\n#1 [pending] Review the smoke run [final]", isError: false },
      { name: "", text: "orphan", isError: true },
    ]);
  });

  test("reads no results from a stream without messages", () => {
    expect(toolResults(JSON.stringify({ type: "result" }))).toEqual([]);
    expect(toolResults("")).toEqual([]);
  });
});
