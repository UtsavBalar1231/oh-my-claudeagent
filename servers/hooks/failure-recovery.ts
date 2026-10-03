import { breakerNote, bumpErrorCount } from "../../src/core/error-counts.ts";
import { isHookDisabled } from "../../src/core/kill-switch.ts";
import { field, text } from "../../src/core/tool-input.ts";
import type { Handler, Payload } from "./registry.ts";

type Recovery = { kind: string; error: string; message: (retry: number, breaker: string) => string | undefined };
type Rule = readonly [RegExp, string];

const SLOW_FAILURE_MS = 120_000;
const DETAIL_CHARS = 200;
const SILENT_TOOLS = new Set(["Grep", "Glob", "WebFetch", "WebSearch"]);

const NESTING_LIMIT =
  "[NESTING LIMIT] The Agent tool is not in this agent's tool list: its definition disallows it, a session restriction removed it, or it is at the subagent depth limit (CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, three layers below the main conversation by default). Every Agent call fails the same way, so do the work directly with the tools you have.";
const CONCURRENCY_CEILING =
  "[CONCURRENCY CEILING] Too many subagents are running at once (platform cap, default 20, raised via CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS). Nothing about the prompt or the agent tier is wrong. Wait for in-flight agents to finish and read their results, then retry this spawn, or narrow the fan-out so fewer agents run at the same time. Do NOT retry immediately and do NOT escalate to oracle.";
const RETRYABLE_AGENT = /rate.limit|quota.exceeded|overloaded|too.many.requests|429|503|capacity|credit.balance|temporarily.unavailable|service.unavailable|timeout|ECONNRESET|ETIMEDOUT|rate_limit|resource_exhausted/i;
const RETRYABLE_AGENT_ADVICE =
  "[RETRYABLE ERROR] The delegation failed due to a transient error (rate limit, capacity, timeout). Claude Code already exhausted its own recovery before this surfaced: a response cut off mid-stream is continued automatically, and a model-level failure is routed through the fallback model chain when one is configured. The failure carries whatever the agent produced before it was cut off: read that partial work, then delegate only the remainder instead of re-sending the original prompt. Do not escalate to oracle for transient failures. The failure is in the service, not in your prompt or approach. Once it clears, resume the same agent with SendMessage so it keeps its history, or delegate only the remainder.";

const EDIT_RULES: readonly Rule[] = [
  [/not unique/i, "The old_string is not unique in the file. Include more surrounding context to make it unique, or use replace_all if you want to replace all occurrences."],
  [/not found/i, "The old_string was not found in the file. The file may have changed. Re-read the file to get current contents before editing."],
  [/permission/i, "Permission denied. Check file permissions or if the file is locked by another process."],
  [/no such file/i, "File does not exist. Use Write tool to create it, or check the file path is correct."],
];
const EDIT_FALLBACK = "Edit failed. Re-read the file to verify current contents match your old_string exactly, including whitespace and indentation.";

// A compile or test failure already reaches the model in full, so that class carries no advice
// and only feeds the counter.
const BASH_RULES: readonly Rule[] = [
  [/command not found|No such file or directory.*bin/i, "Command not found. Check if the tool is installed and on PATH. Try: which <command>"],
  [/Permission denied|EACCES/i, "Permission denied. Check file permissions or try with appropriate access."],
  [/compil.*error|compilation|error TS|SyntaxError|ParseError|FAIL|AssertionError|test.*fail|expect.*received|exit code [1-9]|exited with/i, ""],
  [/timed out|timeout|Command timed out/i, "Command timed out. Consider: run_in_background=true for long operations, a larger timeout param, or narrow the scope (e.g. target a single test file)."],
];
const BASH_SLOW_ADVICE =
  "Command ran for over 2 minutes before failing. Consider run_in_background=true, a larger timeout param, or narrowing scope (e.g. run a single test file).";

const POWERSHELL_RULES: readonly Rule[] = [
  [/is not recognized as the name of a cmdlet/i, "Command not found. The cmdlet, function, script or program is not installed or not on PATH. Try: Get-Command <name>"],
  [/Cannot find path|The system cannot find the path specified/i, "Path not found. Check the spelling and the working directory. Try: Get-ChildItem <parent folder>"],
];

const READ_RULES: readonly Rule[] = [
  [/no such file|not found|ENOENT/i, "File not found. Search for the name with find or rg --files, or check whether the path changed."],
  [
    /permission|EACCES/i,
    "Permission denied. For a path outside the working directories, read it with mcp__plugin_oh-my-claudeagent_omca__file_read, or ask the user to add its directory with /add-dir. If the file's own permissions forbid reading (EACCES), no tool will read it: report that instead of retrying.",
  ],
  [/directory|is a directory/i, "Path is a directory, not a file. List it with ls, or search inside it with find or rg --files."],
];

const MCP_RULES: readonly Rule[] = [
  [/ast.grep.*not found|sg.*not found|No such file.*ast-grep/i, "ast-grep binary not found. Install via: cargo install ast-grep or brew install ast-grep."],
  [/timeout|timed out|deadline exceeded/i, "MCP tool timed out. The codebase may be too large for this operation. Try narrowing the search scope."],
  [
    /not.*connected/i,
    "MCP server not connected. The omca server is plugin-provided, so it is unavailable during a reconnect window or after a plugin reload. Check server health with 'claude mcp list' or /mcp, which report connection status and the server's own error text. Then retry the call: evidence logging via evidence_log must be retried, never skipped, or the completion claim has no evidence behind it.",
  ],
  [/invalid.*yaml|yaml.*parse|YAML.*error/i, "Invalid YAML in ast-grep rule. Check rule syntax. Use ast_test_rule to validate before ast_find_rule."],
  [/mcp.*error|tool.*unavailable|server.*not.*running/i, "MCP server error. The omca server may need restart. Try: /reload-plugins"],
];
const MALFORMED_JSON = /(invalid JSON|malformed JSON|parse error|SyntaxError|Unexpected token|JSON\.parse)/i;

const adviceFor = (rules: readonly Rule[], error: string): string | undefined => rules.find(([pattern]) => pattern.test(error))?.[1];
const withBreaker = (advice: string, breaker: string): string => [advice, breaker].filter(Boolean).join(" ");
const detail = (error: string): string => error.slice(0, DETAIL_CHARS).replace(/\n+$/, "");
const header = (kind: string, tool: string, retry: number): string =>
  `[ERROR RECOVERY] ${kind === "unknown" ? "" : `Type: ${kind} | `}Tool: ${tool} | Retry: ${retry}`;

function edit(error: string): Recovery {
  let kind = "unknown";
  if (/rate.limit|429|timeout|ECONNRESET|ETIMEDOUT/i.test(error)) kind = "transient";
  else if (/not[. ]found|permission|EACCES|ENOENT|invalid.*schema/i.test(error)) kind = "deterministic";
  const advice = adviceFor(EDIT_RULES, error) ?? EDIT_FALLBACK;
  return { kind: "edit_error", error, message: (retry, breaker) => `${header(kind, "Edit", retry)}\n${withBreaker(advice, breaker)}` };
}

function agent(error: string, toolInput: unknown): string | Recovery {
  if (/No such tool available: Agent/i.test(error) || /subagent.*nest|nest.*limit/i.test(error)) return NESTING_LIMIT;
  if (/concurrent subagent limit/i.test(error)) return CONCURRENCY_CEILING;
  const subagent = field(toolInput, "subagent_type");
  const retryable = RETRYABLE_AGENT.test(error);
  const kind = retryable ? "transient" : /not.found|permission|EACCES|ENOENT|invalid.*schema/i.test(error) ? "deterministic" : "unknown";
  const advice = retryable
    ? RETRYABLE_AGENT_ADVICE
    : `[DELEGATE RETRY] Task delegation failed for agent '${typeof subagent === "string" ? subagent : "unknown"}': ${detail(error)}. A mid-stream cutoff and a model-level failure are handled by the platform on their own (automatic continuation, and the fallback model chain when one is configured), so treat this as a real tool failure. Consider: 1) Retry with a more specific prompt, 2) Break the task into smaller pieces.`;
  return {
    kind: "delegate_error",
    error,
    message: (retry, breaker) => `${header(kind, "Agent", retry)}\n${withBreaker(advice, breaker)}`,
  };
}

function bash(error: string, durationMs: number): Recovery | undefined {
  const advice = adviceFor(BASH_RULES, error) ?? (durationMs >= SLOW_FAILURE_MS ? BASH_SLOW_ADVICE : undefined);
  if (advice === undefined) return;
  return {
    kind: "bash_error",
    error,
    message: (_retry, breaker) => {
      const body = withBreaker(advice, breaker);
      return body === "" ? undefined : `[BASH ERROR RECOVERY] ${body}`;
    },
  };
}

function powershell(error: string): Recovery | undefined {
  const advice = adviceFor(POWERSHELL_RULES, error);
  if (advice === undefined) return;
  return { kind: "powershell_error", error, message: (_retry, breaker) => `[POWERSHELL ERROR RECOVERY] ${withBreaker(advice, breaker)}` };
}

function read(error: string): Recovery | undefined {
  const advice = adviceFor(READ_RULES, error);
  if (advice === undefined) return;
  return { kind: "read_error", error, message: (_retry, breaker) => `[READ ERROR RECOVERY] ${withBreaker(advice, breaker)}` };
}

function otherTool(tool: string, error: string): Recovery | undefined {
  const advice = tool.startsWith("mcp__") ? adviceFor(MCP_RULES, error) : undefined;
  const head = advice !== undefined ? `[MCP ERROR RECOVERY] ${advice}` : MALFORMED_JSON.test(error) ? `[JSON ERROR RECOVERY] ${tool} failed on malformed JSON: ${detail(error)}` : undefined;
  if (head === undefined) return;
  return { kind: "other_error", error, message: (_retry, breaker) => withBreaker(head, breaker) };
}

function classify(tool: string, payload: Payload): string | Recovery | undefined {
  const error = text(payload.error);
  switch (tool) {
    case "Edit":
      return edit(error || "Unknown error");
    case "Agent":
      return agent(error || "Unknown error", payload.tool_input);
    case "Bash":
      return bash(error, Number(payload.duration_ms));
    case "PowerShell":
      return powershell(error);
    case "Read":
      return read(error);
    default:
      return SILENT_TOOLS.has(tool) ? undefined : otherTool(tool, error);
  }
}

export const handle: Handler = (payload, { session, now }) => {
  if (isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "failure-recovery")) return;
  const tool = text(payload.tool_name);
  const found = classify(tool, payload);
  if (found === undefined) return;
  let additionalContext: string | undefined;
  if (typeof found === "string") {
    additionalContext = found;
  } else {
    const counts = session === undefined ? new Map() : (session.errorCounts ??= new Map());
    const entry = bumpErrorCount(counts, `${tool}:${found.kind}`, found.error, now);
    additionalContext = found.message(entry.count, breakerNote(entry));
  }
  return additionalContext === undefined ? undefined : { hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext } };
};
