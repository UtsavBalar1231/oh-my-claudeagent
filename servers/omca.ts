#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { OMCA_TOOLS } from "./hooks/subagent-context.ts";
import { ensureStateDir, projectRoot } from "./io.ts";
import { isRecord } from "../src/core/tool-input.ts";
import { type Context, createDispatcher, INVALID_PARAMS, RpcError, type Handler, type Params } from "./jsonrpc.ts";
import { startWork } from "./lifecycle.ts";
import { createProgress, type ToolContext } from "./progress.ts";
import { tools as astTools } from "./tools/ast.ts";
import { tools as boulderTools, unbindBoundSessions } from "./tools/boulder.ts";
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
    title: string;
    readOnlyHint: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint: false;
  };
  _meta?: Record<string, unknown>;
  call: (args: Record<string, unknown>, context?: ToolContext) => string | Promise<string>;
};

const INSTRUCTIONS = [
  "oh-my-claudeagent (OMCA) tools. Its state lives under `.omca/` and is written only through them.",
  "",
  OMCA_TOOLS,
  "",
  "- After a build, test or lint run: `evidence_log`, real exit code included; `evidence_read` lists the entries.",
  "- A multi-step plan: `boulder_write` registers it and binds this session; `boulder_progress` reports it.",
  "- Notes that must outlive compaction: `notepad_write`, `notepad_read`, `notepad_list`, `notepad_compact`.",
  "- Code search by structure, where grep would only match text: `ast_search`, `ast_find_rule`, `ast_test_rule`, `ast_dump_tree`, and `ast_replace` (preview with dry_run).",
  "- A file outside the project root: `file_read`. An earlier session: `session_search`.",
  "- Choosing a delegation target: `agents_list`, `categories_list`. The plugin looks broken: `health_check`.",
  "",
].join("\n");

const MODERN_PROTOCOL = "2026-07-28";
const FALLBACK_PROTOCOL = "2025-11-25";
const SUPPORTED_PROTOCOLS = [MODERN_PROTOCOL, FALLBACK_PROTOCOL];
const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

const tools = [
  ...astTools,
  ...boulderTools,
  ...catalogTools,
  ...evidenceTools,
  ...filesystemTools,
  ...hookTools,
  ...notepadTools,
  ...sessionTools,
].sort((a, b) => (a.name < b.name ? -1 : 1));
const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
const toolList = tools.map(({ call: _call, ...declaration }) => declaration);

const manifestUrl = new URL("../.claude-plugin/plugin.json", import.meta.url);
const serverInfo = { name: "omca", version: String(JSON.parse(readFileSync(manifestUrl, "utf8")).version) };
const capabilities = { tools: { listChanged: false } };
// The tool list is fixed for the life of the process, but a client cache that outlives it
// would serve a stale list after a plugin update, so the client re-lists instead of caching.
const listCache = { ttlMs: 0, cacheScope: "private" };
// Revision 2026-07-28 rejects a result without it; earlier revisions ignore the field.
const complete = { resultType: "complete" };

const toolError = (text: string) => ({ content: [{ type: "text", text }], isError: true, ...complete });

function rejectUnsupportedVersion(params: Params): void {
  const requested = isRecord(params._meta) ? params._meta[PROTOCOL_VERSION_META] : undefined;
  if (typeof requested !== "string" || SUPPORTED_PROTOCOLS.includes(requested)) return;
  throw new RpcError(UNSUPPORTED_PROTOCOL_VERSION, `Unsupported protocol version: ${requested}`, {
    supported: SUPPORTED_PROTOCOLS,
    requested,
  });
}

function progressFor(params: Params, { signal, notify }: Context) {
  const token = isRecord(params._meta) ? params._meta.progressToken : undefined;
  if (typeof token !== "string" && typeof token !== "number") return undefined;
  return createProgress({ token, signal, send: (update) => notify("notifications/progress", update) });
}

async function callTool(params: Params, context: Context) {
  const tool = typeof params.name === "string" ? toolsByName.get(params.name) : undefined;
  if (!tool) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${String(params.name)}`);
  const args = params.arguments ?? {};
  if (!isRecord(args)) return toolError(`${tool.name}: arguments must be an object`);
  const progress = progressFor(params, context);
  try {
    const text = await tool.call(args, { signal: context.signal, progress: progress?.report ?? (() => {}) });
    return { content: [{ type: "text", text }], ...complete };
  } catch (error) {
    if (!context.signal.aborted) console.error(`omca: ${tool.name} failed:`, error);
    return toolError(error instanceof Error ? error.message : String(error));
  } finally {
    progress?.close();
  }
}

const handlers: Record<string, Handler> = {
  "server/discover": () => ({
    supportedVersions: SUPPORTED_PROTOCOLS,
    capabilities,
    instructions: INSTRUCTIONS,
    ...listCache,
    ...complete,
    _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
  }),
  initialize: (params) => {
    if (typeof params.protocolVersion !== "string") {
      throw new RpcError(INVALID_PARAMS, "initialize: protocolVersion must be a string");
    }
    const protocolVersion = SUPPORTED_PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : MODERN_PROTOCOL;
    return { protocolVersion, capabilities, serverInfo, instructions: INSTRUCTIONS, ...complete };
  },
  "notifications/initialized": () => undefined,
  ping: () => ({ ...complete }),
  "tools/list": () => ({ tools: toolList, ...listCache, ...complete }),
  "tools/call": callTool,
};

const checked = Object.fromEntries(
  Object.entries(handlers).map(([method, handler]): [string, Handler] => [
    method,
    (params, context) => {
      rejectUnsupportedVersion(params);
      return handler(params, context);
    },
  ]),
);

// The client sends SIGTERM 100 ms after SIGINT, so the unbind gives up on a busy lock well before then.
const SHUTDOWN_LOCK_WAIT_MS = 50;

let isUnbound = false;

function unbind(): void {
  if (isUnbound) return;
  isUnbound = true;
  try {
    unbindBoundSessions(Date.now() + SHUTDOWN_LOCK_WAIT_MS);
  } catch (error) {
    console.error("omca: unbinding this process's sessions at exit failed:", error);
  }
}

function shutdown(): void {
  unbind();
  process.exit(0);
}

// The client ends a session with SIGINT, then SIGTERM 100 ms later and SIGKILL about 500 ms
// after the SIGINT, and never closes stdin. A killed tmux pane sends SIGHUP first. Windows
// delivers no SIGTERM: it ends a console process with SIGBREAK or by closing its stdin.
const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
if (process.platform === "win32") SHUTDOWN_SIGNALS.push("SIGBREAK");
for (const signal of SHUTDOWN_SIGNALS) process.on(signal, shutdown);
process.on("exit", unbind);

const root = projectRoot(process.cwd());
ensureStateDir(root);
void startWork(root);

const feed = createDispatcher(checked, (line) => process.stdout.write(line));
process.stdin.setEncoding("utf8");
process.stdin.on("data", feed);
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
