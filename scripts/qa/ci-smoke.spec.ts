import { describe, expect, test } from "bun:test";
import { offeredTools, smokeScript } from "./ci-smoke.ts";
import { guardDenies, hookCalls, pluginDenies } from "./lib.ts";

const REASON = "Destructive rm -rf blocked: the target is the filesystem root, home, the working directory, or a directory directly under root or home. Name a deeper path explicitly.";
const BASH_DENY = `2026-10-02T21:20:39.671Z [DEBUG] tool.check Bash toolu_mock_1: unevaluated -> deny by plugin oh-my-claudeagent: ${REASON}`;
const POWERSHELL_DENY = `2026-10-02T21:20:39.700Z [DEBUG] tool.check PowerShell toolu_mock_2: unevaluated -> deny by plugin oh-my-claudeagent: ${REASON}`;
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
});

describe("pluginDenies", () => {
  test("counts every deny by the plugin whatever the tool or reason", () => {
    const other = BASH_DENY.replace("Destructive rm -rf blocked", "Destructive git command blocked");
    expect(pluginDenies([BASH_DENY, POWERSHELL_DENY, other, NOISE].join("\n"))).toHaveLength(3);
    expect(pluginDenies(NOISE)).toEqual([]);
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
