import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { asList, asRecord, type Check, type Context, exists, isRecord, type Outcome, readJson, verdict } from "./core.ts";

const SERVER = "plugin:oh-my-claudeagent:omca";
const SERVER_KEY = "omca";
const TOOL = "omca_hook";
const SESSION_START_MATCHER = "clear|compact";

const hooksJson = (ctx: Context) => asRecord(readJson(join(ctx.root, "hooks", "hooks.json")));

function handlerEntries(ctx: Context): { event: string; handler: Record<string, unknown> }[] {
  return Object.entries(asRecord(hooksJson(ctx).hooks)).flatMap(([event, groups]) =>
    asList(groups).flatMap((group) => asList(asRecord(group).hooks).map((handler) => ({ event, handler: asRecord(handler) }))),
  );
}

function handlerShape(ctx: Context): Outcome {
  const registry = hooksJson(ctx).hooks;
  if (!isRecord(registry)) {
    return { status: "fail", detail: "hooks.json has no hooks object" };
  }
  const entries = handlerEntries(ctx);
  if (entries.length === 0) return { status: "fail", detail: "hooks.json registers no handler" };
  const problems: string[] = [];
  for (const { event, handler } of entries) {
    const where = `${event} handler`;
    if (handler.type !== "mcp_tool") problems.push(`${where} has type ${JSON.stringify(handler.type)}, expected "mcp_tool"`);
    if (handler.server !== SERVER) {
      problems.push(`${where} names server ${JSON.stringify(handler.server)}, expected "${SERVER}"`);
    }
    if (handler.tool !== TOOL) problems.push(`${where} names tool ${JSON.stringify(handler.tool)}, expected "${TOOL}"`);
    if (typeof handler.timeout !== "number" || !(handler.timeout > 0)) problems.push(`${where} sets no positive timeout`);
  }
  const mcp = asRecord(asRecord(readJson(join(ctx.root, ".mcp.json"))).mcpServers);
  if (!(SERVER_KEY in mcp)) problems.push(`.mcp.json registers no "${SERVER_KEY}" server for ${SERVER}`);
  return verdict(problems, `every handler is mcp_tool ${SERVER} ${TOOL} with a timeout`);
}

function sessionStartMatcher(ctx: Context): Outcome {
  const groups = asList(asRecord(hooksJson(ctx).hooks).SessionStart).map(asRecord);
  if (groups.length === 0) return { status: "fail", detail: "hooks.json has no SessionStart entry" };
  const problems = groups.flatMap((group, index) =>
    group.matcher === SESSION_START_MATCHER ? [] : [`SessionStart entry ${index + 1} has matcher ${JSON.stringify(group.matcher)}, expected "${SESSION_START_MATCHER}"`],
  );
  return verdict(problems, `${groups.length} SessionStart entries carry the matcher ${SESSION_START_MATCHER}`);
}

function modules(ctx: Context): Outcome {
  const found = JSON.stringify(hooksJson(ctx).modules);
  return verdict(found === '["./register.ts"]' ? [] : [`modules is ${found}, expected ["./register.ts"]`], 'modules is ["./register.ts"]');
}

const IMPORT = /(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;

export function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file) || !exists(file)) continue;
    seen.add(file);
    for (const [, specifier = ""] of readFileSync(file, "utf8").matchAll(IMPORT)) queue.push(join(dirname(file), specifier));
  }
  return seen;
}

function registryReach(ctx: Context): Outcome {
  const dir = join(ctx.root, "servers", "hooks");
  const registry = join(dir, "registry.ts");
  if (!exists(registry)) return { status: "fail", detail: "servers/hooks/registry.ts is missing" };
  const reached = reachableFrom(registry);
  const handlers = readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".spec.ts"));
  const dead = handlers.filter((name) => !reached.has(join(dir, name)));
  return verdict(
    dead.map((name) => `servers/hooks/${name} is not reached from registry.ts, so it is dead code`),
    `${handlers.length} servers/hooks files are reached from registry.ts`,
  );
}

export const checks: readonly Check[] = [
  { name: "hook handlers", run: handlerShape },
  { name: "hook modules", run: modules },
  { name: "SessionStart matcher", run: sessionStartMatcher },
  { name: "hook registry reach", run: registryReach },
];
