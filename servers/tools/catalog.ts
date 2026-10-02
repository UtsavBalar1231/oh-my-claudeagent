import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../../src/core/frontmatter.ts";
import { isSafeSessionId } from "../../src/core/session-id.ts";
import { findSession, latestSessionId } from "../hooks/session-state.ts";
import { ledgerPath } from "../hooks/status-file.ts";
import { projectRoot } from "../io.ts";
import type { Tool } from "../omca.ts";
import { pluginRoot } from "../plugin-root.ts";
import { discoverBinary } from "./ast.ts";
import { isMissing, stringArg } from "./filesystem.ts";

export type Runtime =
  | { runtime: "ok" }
  | { runtime: "hooks_inactive" | "mod_absent"; runtime_reason: string };

const HOOKS_INACTIVE =
  "No OMCA settings hook has reached the server in this session, so hooks are off: `disableAllHooks` is set, or an organization policy sets `allowManagedHooksOnly`.";
const MOD_ABSENT =
  "The OMCA mod has not marked this session since the last prompt, so it is not running: an organization policy sets `allowManagedModsOnly`, the session started with `--safe-mode`, or the mod worker crashed three times and was unloaded.";

const COST_TIERS: Array<[tier: string, models: string[]]> = [
  ["premium", ["claude-fable-5-1", "claude-fable-5", "fable"]],
  ["expensive", ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "opus"]],
  ["cheap", ["claude-sonnet-5-5", "claude-sonnet-5", "sonnet"]],
  ["free", ["claude-haiku-4-5", "haiku"]],
];
const costTier = (model: string): string => COST_TIERS.find(([, models]) => models.includes(model))?.[0] ?? "cheap";

const CATEGORIES_MISSING = '{"error": "categories.json not found"}';
const CATEGORIES_MALFORMED = '{"error": "categories.json is malformed"}';

const WORKING_DIRECTORY = { type: "string", default: "", description: "Project root (auto-detected from git)" };

const rootOf = (args: Record<string, unknown>): string => projectRoot(stringArg(args, "working_directory", "") || process.cwd());
const isDirectory = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;

function markerWrittenAt(root: string, sessionId: string): number | undefined {
  if (!isSafeSessionId(sessionId)) return undefined;
  try {
    const marker: unknown = JSON.parse(readFileSync(join(root, ".omca", "state", "mod", `${sessionId}.json`), "utf8"));
    const at = typeof marker === "object" && marker !== null && "written_at" in marker ? marker.written_at : undefined;
    return typeof at === "number" ? at : undefined;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export function runtimeOf(root: string): Runtime {
  const sessionId = latestSessionId();
  if (sessionId === undefined) return { runtime: "hooks_inactive", runtime_reason: HOOKS_INACTIVE };
  const writtenAt = markerWrittenAt(root, sessionId);
  const promptAt = findSession(sessionId)?.promptAt ?? 0;
  return writtenAt !== undefined && writtenAt > promptAt
    ? { runtime: "ok" }
    : { runtime: "mod_absent", runtime_reason: MOD_ABSENT };
}

/** The client version the launcher exports to its children as `AI_AGENT=claude-code_2-1-287_agent`. */
function clientVersion(): string | null {
  const parts = /^claude-code_(\d+)-(\d+)-(\d+)_/.exec(process.env.AI_AGENT ?? "");
  return parts === null ? null : parts.slice(1).join(".");
}

function astGrep(): { path: string } | { error: string } {
  try {
    return { path: discoverBinary() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function jsonFileState(path: string): "absent" | "valid" | "invalid" {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return "absent";
    throw error;
  }
  try {
    JSON.parse(text);
    return "valid";
  } catch {
    return "invalid";
  }
}

function healthCheck(args: Record<string, unknown>): string {
  const root = rootOf(args);
  const stateDir = join(root, ".omca", "state");
  const report = {
    ...runtimeOf(root),
    client_version: clientVersion(),
    ast_grep: astGrep(),
    state: {
      dir: isDirectory(stateDir) ? "present" : "absent",
      "boulder.json": jsonFileState(join(stateDir, "boulder.json")),
      "verification-evidence.json": jsonFileState(ledgerPath(root)),
    },
  };
  return JSON.stringify(report, null, 2);
}

function agentFrontmatter(dir: string, file: string) {
  try {
    return parseFrontmatter(readFileSync(join(dir, file), "utf8"));
  } catch (error) {
    throw new Error(`agents/${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function agentsList(): string {
  const dir = join(pluginRoot(), "agents");
  const files = isDirectory(dir) ? readdirSync(dir).filter((file) => file.endsWith(".md")).sort() : [];
  const catalog = files.flatMap((file) => {
    const frontmatter = agentFrontmatter(dir, file);
    if (frontmatter === undefined) return [];
    const { name, description, model } = frontmatter;
    const defaultModel = typeof model === "string" ? model : "sonnet";
    return [
      {
        name: typeof name === "string" ? name : file.slice(0, -".md".length),
        description: typeof description === "string" ? description : "",
        default_model: defaultModel,
        cost_tier: costTier(defaultModel),
      },
    ];
  });
  return JSON.stringify(catalog, null, 2);
}

function categoriesList(): string {
  const path = join(pluginRoot(), "servers", "categories.json");
  if (!existsSync(path)) return CATEGORIES_MISSING;
  try {
    return JSON.stringify(JSON.parse(readFileSync(path, "utf8")), null, 2);
  } catch (error) {
    if (error instanceof SyntaxError) return CATEGORIES_MALFORMED;
    throw error;
  }
}

export const tools: Tool[] = [
  {
    name: "health_check",
    description:
      "Report whether OMCA's runtime is active in this session, plus the client version, the ast-grep binary and the state files. `runtime` is `ok` when this session's settings hooks have reached the server and the OMCA mod has marked the session since the last prompt; otherwise it is `hooks_inactive` or `mod_absent`, and `runtime_reason` names the likely cause. The orchestration skills call this first and stop unless `runtime` is `ok`. `client_version` is null when the client does not export its version. `ast_grep` is `{path}` or `{error}`. `state` gives the state directory as `present` or `absent` and `boulder.json` and `verification-evidence.json` as `absent`, `valid` or `invalid` JSON.",
    inputSchema: { type: "object", properties: { working_directory: WORKING_DIRECTORY } },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    _meta: {
      "anthropic/searchHint": "whether OMCA's hooks and mod are running, and the ast-grep binary and state files are in order",
    },
    call: healthCheck,
  },
  {
    name: "agents_list",
    description:
      'Return a JSON array with one entry per agent file in the plugin\'s agents/ directory: name, description (the frontmatter description), default_model (the frontmatter model alias, "sonnet" when absent), and cost_tier (premium for fable, expensive for opus, cheap for sonnet and unknown values, free for haiku). The Agent tool\'s own agent list already carries names and descriptions; use this when the model or cost tier matters.',
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    _meta: { "anthropic/searchHint": "agent roster with descriptions, default model and cost tier, for delegation routing" },
    call: agentsList,
  },
  {
    name: "categories_list",
    description:
      "Return category-to-model mapping from categories.json. Use when selecting the right model tier for a task category. Returns JSON mapping of category names to model tier.",
    inputSchema: {
      type: "object",
      properties: {
        working_directory: { type: "string", default: "", description: "Unused — reads from plugin dir. Kept for API consistency." },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    _meta: { "anthropic/searchHint": "agent category to model tier mapping" },
    call: categoriesList,
  },
];
