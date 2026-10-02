#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { ensureStateDir, exitHooks, projectRoot } from "./io.ts";
import { createDispatcher, INVALID_PARAMS, isObject, RpcError, type Handler } from "./jsonrpc.ts";
import { tools as astTools } from "./tools/ast.ts";
import { tools as boulderTools } from "./tools/boulder.ts";
import { tools as catalogTools } from "./tools/catalog.ts";
import { tools as evidenceTools } from "./tools/evidence.ts";
import { tools as filesystemTools } from "./tools/filesystem.ts";
import { tools as hookTools } from "./tools/hook.ts";
import { tools as notepadTools } from "./tools/notepad.ts";
import { tools as sessionTools } from "./tools/sessions.ts";

export type Tool = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; [keyword: string]: unknown };
  annotations: {
    title?: string;
    readOnlyHint: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint: false;
  };
  _meta?: Record<string, unknown>;
  call: (args: Record<string, unknown>) => string | Promise<string>;
};

const INSTRUCTIONS = [
  "oh-my-claudeagent (OMCA) tools: verification evidence, work-plan tracking, notepads that survive compaction, structural code search, and reads outside the project root. State lives under `.omca/` in the project root and is written only through these tools; never hand-edit those files.",
  "",
  "Reach for a tool when:",
  "",
  "- You just ran a build, test, or lint command. Record it with `evidence_log`, real exit code included. A plan-bound session cannot stop until a `final_verification` entry exists; when task tools are enabled, a TaskCompleted hook also checks for evidence. `evidence_read` returns everything logged so far.",
  "- You are executing a multi-step plan. `boulder_write` registers it and binds this session; `boulder_progress` reports completed and remaining checkboxes plus the next task.",
  "- You learned something that must outlive a compaction: a discovery, blocker, decision, or open problem. `notepad_write` persists it, `notepad_read` and `notepad_list` recall it, `notepad_compact` shrinks a section that grew large.",
  "- You are searching code by structure rather than text — function signatures, class shapes, import forms, call patterns. `ast_search` beats grep whenever the target is syntactic. `ast_find_rule` handles context-sensitive matches such as calls inside a class, `ast_test_rule` validates a rule on a snippet first, `ast_dump_tree` shows the syntax tree when a pattern will not match, and `ast_replace` rewrites AST-safely (preview with dry_run).",
  "- You need a file outside the project root, where the built-in Read tool is scoped out. `file_read` returns line-numbered content with a token estimate and offset/limit paging.",
  "- You need something from an earlier session here. `session_search` scans local transcripts.",
  "- You are choosing a delegation target. `agents_list` gives each agent's description, cost tier, and default model; `categories_list` maps categories to model tiers.",
  "- The plugin itself looks broken. `health_check` reports on the ast-grep binary and state files.",
  "",
].join("\n");

const MODERN_PROTOCOL = "2026-07-28";
const LEGACY_PROTOCOL = "2025-11-25";
const HOOKS_ROLE_TOOLS = new Set(["omca_hook"]);

const role = process.env.OMCA_SERVER_ROLE;
if (role !== undefined && role !== "hooks") {
  console.error(`omca: unknown OMCA_SERVER_ROLE "${role}"; expected "hooks" or unset`);
  process.exit(2);
}

const declared = [
  ...astTools,
  ...boulderTools,
  ...catalogTools,
  ...evidenceTools,
  ...filesystemTools,
  ...hookTools,
  ...notepadTools,
  ...sessionTools,
];
const tools = role === "hooks" ? declared.filter((tool) => HOOKS_ROLE_TOOLS.has(tool.name)) : declared;
const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
const toolList = tools.map(({ call, ...declaration }) => declaration);

const manifestUrl = new URL("../.claude-plugin/plugin.json", import.meta.url);
const serverInfo = { name: "omca", version: String(JSON.parse(readFileSync(manifestUrl, "utf8")).version) };
const capabilities = { tools: { listChanged: false } };
// The hooks-role server runs beside the Python server, which already sends these instructions.
const instructions = role === "hooks" ? {} : { instructions: INSTRUCTIONS };
// The tool list is fixed for the life of the process, but a client cache that outlives it
// would serve a stale list after a plugin update, so the client re-lists instead of caching.
const listCache = { ttlMs: 0, cacheScope: "private" };
// Revision 2026-07-28 rejects a result without it; earlier revisions ignore the field.
const complete = { resultType: "complete" };

async function callTool(params: Record<string, unknown>) {
  const tool = typeof params.name === "string" ? toolsByName.get(params.name) : undefined;
  if (!tool) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${String(params.name)}`);
  const args = params.arguments ?? {};
  if (!isObject(args)) throw new RpcError(INVALID_PARAMS, `${tool.name}: arguments must be an object`);
  try {
    return { content: [{ type: "text", text: await tool.call(args) }], ...complete };
  } catch (error) {
    console.error(`omca: ${tool.name} failed:`, error);
    const text = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text }], isError: true, ...complete };
  }
}

const handlers: Record<string, Handler> = {
  "server/discover": () => ({
    supportedVersions: [MODERN_PROTOCOL, LEGACY_PROTOCOL],
    capabilities,
    ...instructions,
    ...listCache,
    ...complete,
    _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
  }),
  initialize: (params) => {
    if (typeof params.protocolVersion !== "string") {
      throw new RpcError(INVALID_PARAMS, "initialize: protocolVersion must be a string");
    }
    return { protocolVersion: params.protocolVersion, capabilities, serverInfo, ...instructions };
  },
  "notifications/initialized": () => undefined,
  ping: () => ({}),
  "tools/list": () => ({ tools: toolList, ...listCache, ...complete }),
  "tools/call": callTool,
};

function shutdown(): void {
  for (const hook of exitHooks) {
    try {
      hook();
    } catch (error) {
      console.error("omca: exit hook failed:", error);
    }
  }
  process.exit(0);
}

// The client ends a session with SIGINT, then SIGTERM 100 ms later and SIGKILL about 500 ms
// after the SIGINT, and never closes stdin. A killed tmux pane sends SIGHUP first.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, shutdown);

ensureStateDir(projectRoot(process.cwd()));

const feed = createDispatcher(handlers, (line) => process.stdout.write(line));
process.stdin.setEncoding("utf8");
process.stdin.on("data", feed);
