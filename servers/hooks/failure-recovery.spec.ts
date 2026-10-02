import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch, payloadOf } from "./registry.ts";
import { findSession } from "./session-state.ts";

const NOW = 1_786_000_000_000;
const HOOKS = join(import.meta.dir, "..", "..", "hooks", "hooks.json");
const MINUTE = 60_000;
const BREAKER_TAIL =
  "The count covers every failure of the tool, related or not. If these are repeated attempts at one fix, stop repeating it: change the approach, or ask for a diagnosis, from the advisor tool when you have it and from oracle when you do not.";
const breaker = (attempts: string): string => `This tool has failed 3+ times, each failure within five minutes of the last. Attempts: ${attempts}. ${BREAKER_TAIL}`;

const NOT_FOUND_EDIT = "The old_string was not found in the file. The file may have changed. Re-read the file to get current contents before editing.";
const GENERIC_EDIT = "Edit failed. Re-read the file to verify current contents match your old_string exactly, including whitespace and indentation.";
const NESTING_LIMIT =
  "[NESTING LIMIT] The Agent tool is not in this agent's tool list: its definition disallows it, a session restriction removed it, or it is at the subagent depth limit (CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, three layers below the main conversation by default). Every Agent call fails the same way, so do the work directly with the tools you have.";
const CONCURRENCY_CEILING =
  "[CONCURRENCY CEILING] Too many subagents are running at once (platform cap, default 20, raised via CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS). Nothing about the prompt or the agent tier is wrong. Wait for in-flight agents to finish and read their results, then retry this spawn, or narrow the fan-out so fewer agents run at the same time. Do NOT retry immediately and do NOT escalate to oracle.";
const RETRYABLE_AGENT =
  "[RETRYABLE ERROR] The delegation failed due to a transient error (rate limit, capacity, timeout). Claude Code already exhausted its own recovery before this surfaced: a response cut off mid-stream is continued automatically, and a model-level failure is routed through the fallback model chain when one is configured. The failure carries whatever the agent produced before it was cut off: read that partial work, then delegate only the remainder instead of re-sending the original prompt. Do not escalate to oracle for transient failures. The failure is in the service, not in your prompt or approach. Once it clears, resume the same agent with SendMessage so it keeps its history, or delegate only the remainder.";
const DELEGATE_TAIL =
  "A mid-stream cutoff and a model-level failure are handled by the platform on their own (automatic continuation, and the fallback model chain when one is configured), so treat this as a real tool failure. Consider: 1) Retry with a more specific prompt, 2) Break the task into smaller pieces.";
const delegateRetry = (retry: number, type: string, summary: string, cls = "unknown"): string =>
  `[ERROR RECOVERY] Type: ${cls} | Tool: Agent | Retry: ${retry}/3\n[DELEGATE RETRY] Task delegation failed for agent '${type}': ${summary}. ${DELEGATE_TAIL}`;
const COMMAND_NOT_FOUND = "[BASH ERROR RECOVERY] Command not found. Check if the tool is installed and on PATH. Try: which <command>";
const BASH_TIMEOUT =
  "[BASH ERROR RECOVERY] Command timed out. Consider: run_in_background=true for long operations, a larger timeout param, or narrow the scope (e.g. target a single test file).";
const BASH_SLOW =
  "[BASH ERROR RECOVERY] Command ran for over 2 minutes before failing. Consider run_in_background=true, a larger timeout param, or narrowing scope (e.g. run a single test file).";
const READ_PERMISSION =
  "[READ ERROR RECOVERY] Permission denied. For a path outside the working directories, read it with mcp__plugin_oh-my-claudeagent_omca__file_read, or ask the user to add its directory with /add-dir. If the file's own permissions forbid reading (EACCES), no tool will read it: report that instead of retrying.";
const NOT_CONNECTED =
  "[MCP ERROR RECOVERY] MCP server not connected. The omca server is plugin-provided, so it is unavailable during a reconnect window or after a plugin reload. Check server health with 'claude mcp list' or /mcp, which report connection status and the server's own error text. Then retry the call: evidence logging via evidence_log must be retried, never skipped, or the completion claim has no evidence behind it.";

const roots: string[] = [];

afterEach(() => {
  delete process.env.OMCA_DISABLED_HOOKS;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Failures = {
  sessionId: string;
  report: (fields: Record<string, unknown>, at?: number) => Promise<string | undefined>;
};

function session(sessionId: string = crypto.randomUUID()): Failures {
  const root = mkdtempSync(join(tmpdir(), "omca-failure-"));
  roots.push(root);
  return {
    sessionId,
    report: async (fields, at = NOW) => {
      const output = await dispatch({ event: "PostToolUseFailure", session_id: sessionId, ...fields }, root, at);
      return output.hookSpecificOutput?.additionalContext as string | undefined;
    },
  };
}

const edit = (error?: string) => ({ tool_name: "Edit", tool_input: { file_path: "/tmp/foo.sh" }, ...(error !== undefined && { error }) });
const agent = (error?: string, type = "oh-my-claudeagent:executor") => ({ tool_name: "Agent", tool_input: { subagent_type: type }, ...(error !== undefined && { error }) });
const bash = (error?: string, extra: Record<string, unknown> = {}) => ({ tool_name: "Bash", tool_input: { command: "run-it" }, ...(error !== undefined && { error }), ...extra });
const powershell = (error?: string, extra: Record<string, unknown> = {}) => ({ tool_name: "PowerShell", tool_input: { command: "run-it" }, ...(error !== undefined && { error }), ...extra });
const read = (error?: string) => ({ tool_name: "Read", tool_input: { file_path: "/tmp/f" }, ...(error !== undefined && { error }) });
const tool = (name: string, error?: string) => ({ tool_name: name, ...(error !== undefined && { error }) });

const counts = (sessionId: string) => findSession(sessionId)?.errorCounts;

describe("recorded failure payloads", () => {
  const cases: [string, Record<string, unknown>, string | undefined][] = [
    ["Bash command not found", bash("zsh: command not found: foobar"), COMMAND_NOT_FOUND],
    ["Bash permission denied", bash("Permission denied: cannot write to /etc/hosts"), "[BASH ERROR RECOVERY] Permission denied. Check file permissions or try with appropriate access."],
    ["Bash test failure", bash("FAIL: test_login_works\nAssertionError: expected 200, got 401"), undefined],
    ["Bash timeout", bash("Command timed out after 60000ms", { duration_ms: 60000 }), BASH_TIMEOUT],
    ["Bash slow unclassified failure", bash("some completely unknown error", { duration_ms: 300000 }), BASH_SLOW],
    ["Agent nesting limit", agent("No such tool available: Agent"), NESTING_LIMIT],
    ["Agent rate limit", agent("rate_limit: 429 Too Many Requests"), `[ERROR RECOVERY] Type: transient | Tool: Agent | Retry: 1/3\n${RETRYABLE_AGENT}`],
    ["Edit old_string not found", { tool_name: "Edit", tool_input: { file_path: "/project/src/main.py" }, error: "File not found: /project/src/main.py" }, `[ERROR RECOVERY] Type: deterministic | Tool: Edit | Retry: 1/3\n${NOT_FOUND_EDIT}`],
    ["Edit transient timeout", { tool_name: "Edit", tool_input: { file_path: "/project/src/main.py" }, error: "timeout: operation timed out" }, `[ERROR RECOVERY] Type: transient | Tool: Edit | Retry: 1/3\n${GENERIC_EDIT}`],
    ["MCP tool ast-grep missing", tool("mcp__omca__ast_search", "ast-grep not found in PATH"), "[MCP ERROR RECOVERY] ast-grep binary not found. Install via: cargo install ast-grep or brew install ast-grep."],
    ["MCP tool timeout", tool("mcp__omca__ast_search", "timeout: MCP server did not respond"), "[MCP ERROR RECOVERY] MCP tool timed out. The codebase may be too large for this operation. Try narrowing the search scope."],
    ["Read missing file", tool("Read", "No such file or directory: /project/missing.txt"), "[READ ERROR RECOVERY] File not found. Search for the name with find or rg --files, or check whether the path changed."],
    ["Read directory", tool("Read", "Is a directory: /project/src"), "[READ ERROR RECOVERY] Path is a directory, not a file. List it with ls, or search inside it with find or rg --files."],
  ];

  test.each(cases)("%s", async (_name, fields, expected) => {
    expect(await session().report(fields)).toBe(expected);
  });
});

describe("Edit failures", () => {
  test("a string that is not unique asks for more context or replace_all", async () => {
    expect(await session().report(edit("old_string is not unique in the file"))).toBe(
      "[ERROR RECOVERY] Type: unknown | Tool: Edit | Retry: 1/3\nThe old_string is not unique in the file. Include more surrounding context to make it unique, or use replace_all if you want to replace all occurrences.",
    );
  });

  test("a missing string asks to re-read the file", async () => {
    expect(await session().report(edit("old_string not found in file"))).toBe(`[ERROR RECOVERY] Type: deterministic | Tool: Edit | Retry: 1/3\n${NOT_FOUND_EDIT}`);
  });

  test("a permission error points at file permissions", async () => {
    expect(await session().report(edit("EACCES: permission denied"))).toBe(
      "[ERROR RECOVERY] Type: deterministic | Tool: Edit | Retry: 1/3\nPermission denied. Check file permissions or if the file is locked by another process.",
    );
  });

  test("a missing file points at Write", async () => {
    expect(await session().report(edit("no such file: /tmp/x"))).toBe(
      "[ERROR RECOVERY] Type: unknown | Tool: Edit | Retry: 1/3\nFile does not exist. Use Write tool to create it, or check the file path is correct.",
    );
  });

  test("an unrecognised error gets the generic re-read advice", async () => {
    expect(await session().report(edit("something odd"))).toBe(`[ERROR RECOVERY] Type: unknown | Tool: Edit | Retry: 1/3\n${GENERIC_EDIT}`);
  });

  test("a rate limit is typed transient even when the advice is the generic one", async () => {
    expect(await session().report(edit("429 rate limit"))).toStartWith("[ERROR RECOVERY] Type: transient | Tool: Edit | Retry: 1/3\n");
  });

  test("the retry number climbs with each failure", async () => {
    const { report } = session();
    const retries = [];
    for (let i = 0; i < 3; i++) retries.push((await report(edit("old_string not found in file"), NOW + i))?.match(/Retry: (\d)\/3/)?.[1]);
    expect(retries).toEqual(["1", "2", "3"]);
  });

  test("a payload without an error field gets the generic advice and an Unknown error attempt", async () => {
    const { report } = session();
    expect(await report(edit(), NOW)).toBe(`[ERROR RECOVERY] Type: unknown | Tool: Edit | Retry: 1/3\n${GENERIC_EDIT}`);
    await report(edit(), NOW + 1);
    expect(await report(edit(), NOW + 2)).toBe(
      `[ERROR RECOVERY] Type: unknown | Tool: Edit | Retry: 3/3\n${GENERIC_EDIT} ${breaker("1) Unknown error 2) Unknown error 3) Unknown error")}`,
    );
  });

  test("a payload whose message sits under a field the client does not send is treated as having no error", async () => {
    expect(await session().report({ tool_name: "Edit", tool_input: { file_path: "/tmp/foo.sh" }, tool_result: { error: "old_string not found in file" } })).toBe(
      `[ERROR RECOVERY] Type: unknown | Tool: Edit | Retry: 1/3\n${GENERIC_EDIT}`,
    );
  });
});

describe("Agent failures", () => {
  test("a missing Agent tool gets the nesting advice and no count", async () => {
    const { report, sessionId } = session();
    expect(await report(agent("No such tool available: Agent"))).toBe(NESTING_LIMIT);
    expect(counts(sessionId)).toBeUndefined();
  });

  test("a nesting-limit error text gets the nesting advice", async () => {
    expect(await session().report(agent("subagent nesting is not allowed"))).toBe(NESTING_LIMIT);
  });

  test("the concurrency ceiling gets wait advice and no count", async () => {
    const { report, sessionId } = session();
    expect(await report(agent("Concurrent subagent limit reached"))).toBe(CONCURRENCY_CEILING);
    expect(counts(sessionId)).toBeUndefined();
  });

  test("repeated concurrency ceilings never reach the breaker", async () => {
    const { report, sessionId } = session();
    for (let i = 0; i < 3; i++) expect(await report(agent("Concurrent subagent limit reached"), NOW + i)).toBe(CONCURRENCY_CEILING);
    expect(counts(sessionId)).toBeUndefined();
  });

  test("a transient error tells the caller to resume from the partial work", async () => {
    expect(await session().report(agent("rate_limit: 429 Too Many Requests"))).toBe(`[ERROR RECOVERY] Type: transient | Tool: Agent | Retry: 1/3\n${RETRYABLE_AGENT}`);
  });

  test("each retryable pattern takes the transient branch", async () => {
    for (const error of ["quota exceeded", "API overloaded", "too many requests", "HTTP 503", "no capacity", "credit balance is too low", "temporarily unavailable", "service unavailable", "request timeout", "ECONNRESET", "ETIMEDOUT", "resource_exhausted"]) {
      expect(await session().report(agent(error))).toStartWith("[ERROR RECOVERY] Type: transient | Tool: Agent | Retry: 1/3\n[RETRYABLE ERROR]");
    }
  });

  test("any other error names the agent and quotes the error", async () => {
    expect(await session().report(agent("Agent failed: some error"))).toBe(delegateRetry(1, "oh-my-claudeagent:executor", "Agent failed: some error"));
  });

  test("a missing-resource error is typed deterministic", async () => {
    expect(await session().report(agent("agent not found: nope"))).toBe(delegateRetry(1, "oh-my-claudeagent:executor", "agent not found: nope", "deterministic"));
  });

  test("a call without a subagent type is named unknown, and a long error is quoted to 200 characters", async () => {
    const error = `${"e".repeat(190)}${"f".repeat(30)}`;
    expect(await session().report({ tool_name: "Agent", error })).toBe(delegateRetry(1, "unknown", error.slice(0, 200)));
  });

  test("a payload without an error field is quoted as Unknown error", async () => {
    expect(await session().report(agent())).toBe(delegateRetry(1, "oh-my-claudeagent:executor", "Unknown error"));
  });

  test("an Agent failure counts under Agent:delegate_error and nothing else", async () => {
    const { report, sessionId } = session();
    await report(agent("Agent failed: some error"), NOW);
    await report(agent("Agent failed: some error"), NOW + 1);
    expect([...(counts(sessionId) ?? [])].map(([key, { count }]) => [key, count])).toEqual([["Agent:delegate_error", 2]]);
  });

  test("a streak older than five minutes decays back to a first failure", async () => {
    const { report } = session();
    await report(agent("Agent failed: attempt"), NOW);
    expect(await report(agent("Agent failed: attempt"), NOW + 1)).toContain("Retry: 2/3");
    expect(await report(agent("Agent failed: attempt"), NOW + 1 + 6 * MINUTE)).toContain("Retry: 1/3");
  });

  test("the third failure adds the breaker with a timeline of the three attempts", async () => {
    const { report } = session();
    await report(agent("Agent failed: first issue"), NOW);
    await report(agent("Agent failed: second issue"), NOW + 1);
    expect(await report(agent("Agent failed: third issue"), NOW + 2)).toBe(
      `${delegateRetry(3, "oh-my-claudeagent:executor", "Agent failed: third issue")} ${breaker("1) Agent failed: first issue 2) Agent failed: second issue 3) Agent failed: third issue")}`,
    );
  });

  test("the breaker lists only the three newest attempts after a fourth failure", async () => {
    const { report } = session();
    let last: string | undefined;
    for (const issue of [1, 2, 3, 4]) last = await report(agent(`Agent failed: issue ${issue}`), NOW + issue);
    expect(last).toEndWith(breaker("1) Agent failed: issue 2 2) Agent failed: issue 3 3) Agent failed: issue 4"));
  });

  test("the breaker closes a transient delegation failure too", async () => {
    const { report } = session();
    let last: string | undefined;
    for (let i = 0; i < 3; i++) last = await report(agent("rate_limit: 429"), NOW + i);
    expect(last).toBe(`[ERROR RECOVERY] Type: transient | Tool: Agent | Retry: 3/3\n${RETRYABLE_AGENT} ${breaker("1) rate_limit: 429 2) rate_limit: 429 3) rate_limit: 429")}`);
  });
});

describe("Bash failures", () => {
  test("a command-not-found error gets PATH advice", async () => {
    expect(await session().report(bash("foobar: command not found"))).toBe(COMMAND_NOT_FOUND);
  });

  test("a timed-out error gets timeout coaching", async () => {
    expect(await session().report(bash("Command timed out after 60000ms", { duration_ms: 60000 }))).toBe(BASH_TIMEOUT);
  });

  test("a test failure adds no advice but still counts toward the breaker", async () => {
    const { report, sessionId } = session();
    expect(await report(bash("FAIL: 3 tests failed. AssertionError: expected true"))).toBeUndefined();
    expect(counts(sessionId)?.get("Bash:bash_error")?.count).toBe(1);
  });

  test("three test failures in a row surface the breaker on its own", async () => {
    const { report } = session();
    await report(bash("FAIL: one"), NOW);
    await report(bash("FAIL: two"), NOW + 1);
    expect(await report(bash("FAIL: three"), NOW + 2)).toBe(`[BASH ERROR RECOVERY] ${breaker("1) FAIL: one 2) FAIL: two 3) FAIL: three")}`);
  });

  test("an unclassified error adds no advice and is not counted", async () => {
    const { report, sessionId } = session();
    expect(await report(bash("some completely unknown error"))).toBeUndefined();
    expect(counts(sessionId)).toBeUndefined();
  });

  test("an unclassified error that took two minutes or more gets slow-failure coaching", async () => {
    expect(await session().report(bash("some completely unknown error", { duration_ms: 120000 }))).toBe(BASH_SLOW);
  });

  test("an unclassified error under two minutes adds no advice", async () => {
    expect(await session().report(bash("some completely unknown error", { duration_ms: 119999 }))).toBeUndefined();
  });

  test("the duration arrives as text on the wire and is still read", async () => {
    const root = mkdtempSync(join(tmpdir(), "omca-failure-"));
    roots.push(root);
    const wire = payloadOf({ event: "PostToolUseFailure", session_id: crypto.randomUUID(), tool_name: "Bash", tool_input: JSON.stringify({ command: "x" }), error: "some completely unknown error", duration_ms: "300000" });
    expect((await dispatch(wire, root, NOW)).hookSpecificOutput?.additionalContext).toBe(BASH_SLOW);
  });

  test("Bash: a message under a field the client does not send produces no advice", async () => {
    expect(await session().report({ tool_name: "Bash", tool_input: { command: "foobar" }, tool_error: "foobar: command not found" })).toBeUndefined();
  });

  test("a classified failure after the breaker keeps the advice and appends the note", async () => {
    const { report } = session();
    await report(bash("foobar: command not found"), NOW);
    await report(bash("foobar: command not found"), NOW + 1);
    expect(await report(bash("foobar: command not found"), NOW + 2)).toBe(
      `${COMMAND_NOT_FOUND} ${breaker("1) foobar: command not found 2) foobar: command not found 3) foobar: command not found")}`,
    );
  });
});

const NOT_A_CMDLET = "[POWERSHELL ERROR RECOVERY] Command not found. The cmdlet, function, script or program is not installed or not on PATH. Try: Get-Command <name>";
const NO_SUCH_PATH = "[POWERSHELL ERROR RECOVERY] Path not found. Check the spelling and the working directory. Try: Get-ChildItem <parent folder>";

describe("PowerShell failures", () => {
  test("an unknown command gets Get-Command advice", async () => {
    expect(await session().report(powershell("foobar : The term 'foobar' is not recognized as the name of a cmdlet, function, script file, or operable program."))).toBe(NOT_A_CMDLET);
  });

  test("a missing path gets listing advice, in both of PowerShell's wordings", async () => {
    expect(await session().report(powershell("Get-Content : Cannot find path 'C:\\nope.txt' because it does not exist."))).toBe(NO_SUCH_PATH);
    expect(await session().report(powershell("The system cannot find the path specified."))).toBe(NO_SUCH_PATH);
  });

  test("a JSON parse error is never read with the JSON-error rule", async () => {
    for (const error of ["ConvertFrom-Json : Invalid JSON primitive: x.", "SyntaxError: Unexpected token } in JSON", "malformed JSON", "parse error"]) {
      const { report, sessionId } = session();
      expect(await report(powershell(error))).toBeUndefined();
      expect(counts(sessionId)).toBeUndefined();
    }
  });

  test("Bash's command-not-found and timeout rules do not apply to it", async () => {
    expect(await session().report(powershell("foobar: command not found"))).toBeUndefined();
    expect(await session().report(powershell("Command timed out after 60000ms", { duration_ms: 60000 }))).toBeUndefined();
    expect(await session().report(powershell("some completely unknown error", { duration_ms: 300000 }))).toBeUndefined();
  });

  test("an unrecognised error adds no advice and is not counted", async () => {
    const { report, sessionId } = session();
    expect(await report(powershell("something else broke"))).toBeUndefined();
    expect(await report(powershell())).toBeUndefined();
    expect(counts(sessionId)).toBeUndefined();
  });

  test("a message under a field the client does not send produces no advice", async () => {
    expect(await session().report({ tool_name: "PowerShell", tool_input: { command: "x" }, tool_error: "x : The term 'x' is not recognized as the name of a cmdlet" })).toBeUndefined();
  });

  test("it counts under its own key and the third failure carries the breaker", async () => {
    const { report, sessionId } = session();
    await report(powershell("a : The term 'a' is not recognized as the name of a cmdlet"), NOW);
    await report(powershell("b : The term 'b' is not recognized as the name of a cmdlet"), NOW + 1);
    expect(await report(powershell("c : The term 'c' is not recognized as the name of a cmdlet"), NOW + 2)).toBe(
      `${NOT_A_CMDLET} ${breaker("1) a : The term 'a' is not recognized as the name of a cmdlet 2) b : The term 'b' is not recognized as the name of a cmdlet 3) c : The term 'c' is not recognized as the name of a cmdlet")}`,
    );
    expect([...(counts(sessionId) ?? [])].map(([key, { count }]) => [key, count])).toEqual([["PowerShell:powershell_error", 3]]);
  });

  test("OMCA_DISABLED_HOOKS naming failure-recovery silences it", async () => {
    process.env.OMCA_DISABLED_HOOKS = "failure-recovery";
    expect(await session().report(powershell("x : The term 'x' is not recognized as the name of a cmdlet"))).toBeUndefined();
  });
});

describe("Read failures", () => {
  test("a missing file gets a search suggestion", async () => {
    expect(await session().report(read("No such file or directory: /nonexistent/file.txt"))).toBe(
      "[READ ERROR RECOVERY] File not found. Search for the name with find or rg --files, or check whether the path changed.",
    );
  });

  test("a directory path gets a listing suggestion", async () => {
    expect(await session().report(read("Path is a directory, not a file"))).toBe(
      "[READ ERROR RECOVERY] Path is a directory, not a file. List it with ls, or search inside it with find or rg --files.",
    );
  });

  test("a permission error points at file_read and /add-dir, never a shell read", async () => {
    const advice = await session().report(read("EACCES: permission denied, open /etc/shadow"));
    expect(advice).toBe(READ_PERMISSION);
    expect(advice).not.toContain("cat /");
  });

  test("an unclassified error adds no advice and is not counted", async () => {
    const { report, sessionId } = session();
    expect(await report(read("something else broke"))).toBeUndefined();
    expect(counts(sessionId)).toBeUndefined();
  });

  test("Read: a message under a field the client does not send produces no advice", async () => {
    expect(await session().report({ tool_name: "Read", tool_input: { file_path: "/no/such/file.txt" }, tool_error: "ENOENT: no such file or directory" })).toBeUndefined();
  });

  test("the third classified failure carries the breaker", async () => {
    const { report } = session();
    await report(read("ENOENT: a"), NOW);
    await report(read("ENOENT: b"), NOW + 1);
    expect(await report(read("ENOENT: c"), NOW + 2)).toBe(
      `[READ ERROR RECOVERY] File not found. Search for the name with find or rg --files, or check whether the path changed. ${breaker("1) ENOENT: a 2) ENOENT: b 3) ENOENT: c")}`,
    );
  });
});

describe("failures of any other tool", () => {
  test("a JSON parse error quotes the tool and the error", async () => {
    expect(await session().report(tool("mcp__omca__ast_search", "invalid JSON: Unexpected token } at position 42"))).toBe(
      "[JSON ERROR RECOVERY] mcp__omca__ast_search failed on malformed JSON: invalid JSON: Unexpected token } at position 42",
    );
  });

  test("the quoted JSON error stops at 200 characters", async () => {
    const error = `invalid JSON: ${"x".repeat(300)}`;
    expect(await session().report(tool("mcp__omca__ast_search", error))).toBe(`[JSON ERROR RECOVERY] mcp__omca__ast_search failed on malformed JSON: ${error.slice(0, 200)}`);
  });

  test("a plugin server that is not connected gets reconnect guidance and the retry rule", async () => {
    const advice = await session().report(tool("mcp__plugin_oh-my-claudeagent_omca__evidence_log", "MCP server 'plugin:oh-my-claudeagent:omca' not connected"));
    expect(advice).toBe(NOT_CONNECTED);
  });

  test("a wrapped not-connected error is caught before the generic server-error branch", async () => {
    const advice = await session().report(tool("mcp__plugin_oh-my-claudeagent_omca__boulder_write", "Error: MCP server 'plugin:oh-my-claudeagent:omca' not connected"));
    expect(advice).toBe(NOT_CONNECTED);
    expect(advice).not.toContain("/reload-plugins");
  });

  test("an invalid YAML rule points at ast_test_rule", async () => {
    expect(await session().report(tool("mcp__omca__ast_find_rule", "invalid yaml at line 3"))).toBe(
      "[MCP ERROR RECOVERY] Invalid YAML in ast-grep rule. Check rule syntax — use ast_test_rule to validate before ast_find_rule.",
    );
  });

  test("a server error points at reloading plugins", async () => {
    expect(await session().report(tool("mcp__omca__ast_search", "mcp tool error"))).toBe("[MCP ERROR RECOVERY] MCP server error. The omca server may need restart. Try: /reload-plugins");
  });

  test("an error that matches nothing adds no advice and is not counted", async () => {
    const { report, sessionId } = session();
    expect(await report(tool("mcp__omca__ast_search", "no match"))).toBeUndefined();
    expect(counts(sessionId)).toBeUndefined();
  });

  test.each([
    ["Bash", undefined],
    ["PowerShell", undefined],
    ["Edit", "[ERROR RECOVERY] Type: unknown | Tool: Edit | Retry: 1/3\n"],
    ["Agent", "[ERROR RECOVERY] Type: unknown | Tool: Agent | Retry: 1/3\n[DELEGATE RETRY]"],
    ["Grep", undefined],
    ["Glob", undefined],
    ["WebFetch", undefined],
    ["WebSearch", undefined],
  ])("%s keeps its own advice and never takes the generic JSON branch", async (name, start) => {
    const advice = await session().report(tool(name as string, "invalid JSON in output"));
    if (start === undefined) expect(advice).toBeUndefined();
    else expect(advice).toStartWith(start as string);
  });

  test("an MCP tool: a message under a field the client does not send produces no advice", async () => {
    expect(await session().report({ tool_name: "mcp__omca__ast_search", tool_result: { error: "invalid JSON: Unexpected token }" } })).toBeUndefined();
  });

  test("the breaker counts each tool separately", async () => {
    const { report } = session();
    await report(tool("mcp__a__t", "timeout"), NOW);
    await report(tool("mcp__a__t", "timeout"), NOW + 1);
    expect(await report(tool("mcp__b__t", "timeout"), NOW + 2)).toBe("[MCP ERROR RECOVERY] MCP tool timed out. The codebase may be too large for this operation. Try narrowing the search scope.");
    expect(await report(tool("mcp__a__t", "timeout"), NOW + 3)).toContain("Attempts: 1) timeout 2) timeout 3) timeout.");
  });
});

describe("session scope and switches", () => {
  test("two sessions keep separate counts", async () => {
    const first = session();
    const second = session();
    await first.report(edit("old_string not found in file"), NOW);
    expect(await first.report(edit("old_string not found in file"), NOW + 1)).toContain("Retry: 2/3");
    expect(await second.report(edit("old_string not found in file"), NOW + 2)).toContain("Retry: 1/3");
  });

  test("a call without a session id is advised but cannot count", async () => {
    const { report } = session("");
    await report(edit("old_string not found in file"), NOW);
    expect(await report(edit("old_string not found in file"), NOW + 1)).toContain("Retry: 1/3");
  });

  test("OMCA_DISABLED_HOOKS naming failure-recovery silences the advice and stops the counting", async () => {
    process.env.OMCA_DISABLED_HOOKS = "failure-recovery";
    const { report, sessionId } = session();
    expect(await report(edit("old_string not found in file"))).toBeUndefined();
    expect(counts(sessionId)).toBeUndefined();
  });

  test("all disables it too", async () => {
    process.env.OMCA_DISABLED_HOOKS = "all";
    expect(await session().report(bash("foobar: command not found"))).toBeUndefined();
  });

  test("naming another hook leaves it on", async () => {
    process.env.OMCA_DISABLED_HOOKS = "comment-gate";
    expect(await session().report(bash("foobar: command not found"))).toBe(COMMAND_NOT_FOUND);
  });
});

test("hooks.json routes every tool failure to omca_hook through one unfiltered entry", () => {
  expect(JSON.parse(readFileSync(HOOKS, "utf8")).hooks.PostToolUseFailure).toEqual([
    {
      hooks: [
        {
          type: "mcp_tool",
          server: "plugin:oh-my-claudeagent:omca",
          tool: "omca_hook",
          timeout: 10,
          input: {
            event: "PostToolUseFailure",
            session_id: "${session_id}",
            agent_id: "${agent_id}",
            tool_name: "${tool_name}",
            tool_input: "${tool_input}",
            error: "${error}",
            duration_ms: "${duration_ms}",
          },
        },
      ],
    },
  ]);
});
