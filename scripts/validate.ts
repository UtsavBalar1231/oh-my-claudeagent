// Validates the plugin tree: manifests, frontmatter, docs, hook registration, the mod's
// registrations, repository layout, and the omca server's MCP handshake.
//
// Usage: bun scripts/validate.ts [--check <name>]... [--marketplace <path>]
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type Check, type Context, createContext, type Outcome, type Run, type Status } from "./validate/core.ts";
import * as docs from "./validate/docs.ts";
import * as engine from "./validate/engine.ts";
import * as frontmatter from "./validate/frontmatter.ts";
import * as hooks from "./validate/hooks.ts";
import * as manifest from "./validate/manifest.ts";
import * as mcp from "./validate/mcp.ts";
import * as mod from "./validate/mod.ts";
import * as policy from "./validate/policy.ts";
import * as portability from "./validate/portability.ts";
import * as promptHistory from "./validate/prompt-history.ts";
import * as tree from "./validate/tree.ts";

export const GROUPS = {
  claims: [
    ...manifest.checks,
    ...frontmatter.checks,
    ...policy.checks,
    ...portability.checks,
    ...docs.checks,
    ...promptHistory.checks,
  ],
  hooks: hooks.checks,
  mod: mod.checks,
  tree: tree.checks,
  engine: engine.checks,
  mcp: mcp.checks,
} satisfies Readonly<Record<string, readonly Check[]>>;

const isGroup = (name: string): name is keyof typeof GROUPS => name in GROUPS;

const USAGE = `Usage: bun scripts/validate.ts [options]

Options:
  --check <${Object.keys(GROUPS).join("|")}>   Run one group of checks (repeatable)
  --marketplace <path>   Validate another marketplace file
  --help                 Show this text

With no --check, every group runs. The engine group skips without the claude CLI.`;

const LABEL: Record<Status, string> = { pass: "PASS", fail: "FAIL", skip: "SKIP", warn: "WARN" };

async function runCheck(check: Check, ctx: Context): Promise<Outcome> {
  try {
    return await check.run(ctx);
  } catch (error) {
    return { status: "fail", detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function runChecks(checks: readonly Check[], ctx: Context): Promise<{ lines: string[]; failed: boolean }> {
  const counts: Record<Status, number> = { pass: 0, fail: 0, skip: 0, warn: 0 };
  const lines: string[] = [];
  for (const check of checks) {
    const { status, detail } = await runCheck(check, ctx);
    counts[status] += 1;
    lines.push(`${LABEL[status]}: ${check.name}: ${detail}`);
  }
  lines.push(`Summary: ${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped, ${counts.warn} warned`);
  return { lines, failed: counts.fail > 0 };
}

export async function main(args: string[], root: string): Promise<Run> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(args);
  } catch (error) {
    return { code: 2, stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\n${USAGE}\n` };
  }
  const { check: requested = [], marketplace, help } = parsed.values;
  if (help) return { code: 0, stdout: `${USAGE}\n`, stderr: "" };
  const unknown = requested.find((name) => !isGroup(name));
  if (unknown !== undefined) return { code: 2, stdout: "", stderr: `Unsupported check '${unknown}'\n${USAGE}\n` };
  const names = (requested.length > 0 ? requested : Object.keys(GROUPS)).filter(isGroup);
  const ctx = createContext(
    root,
    marketplace === undefined ? {} : { marketplacePath: resolve(marketplace), marketplaceOverride: true },
  );
  const { lines, failed } = await runChecks(names.flatMap((name) => GROUPS[name]), ctx);
  return { code: failed ? 1 : 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
}

const parse = (args: string[]) =>
  parseArgs({
    args,
    options: { check: { type: "string", multiple: true }, marketplace: { type: "string" }, help: { type: "boolean" } },
    allowPositionals: false,
  });

if (import.meta.main) {
  const { code, stdout, stderr } = await main(Bun.argv.slice(2), join(import.meta.dir, ".."));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
