import { join } from "node:path";
import { asList, asRecord, type Check, type Context, type Outcome, readJson, relative, text, verdict } from "./core.ts";

const PLUGIN_NAME = "oh-my-claudeagent";
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const pluginJson = (ctx: Context) => join(ctx.root, ".claude-plugin", "plugin.json");
const packageJson = (ctx: Context) => join(ctx.root, "package.json");

function jsonFiles(ctx: Context): string[] {
  return [
    join(ctx.root, "hooks", "hooks.json"),
    pluginJson(ctx),
    ctx.marketplacePath,
    join(ctx.root, ".mcp.json"),
    join(ctx.root, "servers", "categories.json"),
    packageJson(ctx),
  ];
}

function jsonValid(ctx: Context): Outcome {
  const problems: string[] = [];
  const files = jsonFiles(ctx);
  for (const file of files) {
    try {
      readJson(file);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      problems.push(`${relative(ctx.root, file)}: ${reason}`);
    }
  }
  return verdict(problems, `${files.length} manifests and configs parse as JSON`);
}

function pluginName(ctx: Context): Outcome {
  const name = text(asRecord(readJson(pluginJson(ctx))).name);
  return verdict(name === PLUGIN_NAME ? [] : [`plugin.json name is ${JSON.stringify(name)}`], `plugin.json names ${PLUGIN_NAME}`);
}

const marketplacePlugins = (ctx: Context) => asList(asRecord(readJson(ctx.marketplacePath)).plugins).map(asRecord);

function marketplaceEntry(ctx: Context): Outcome {
  const found = marketplacePlugins(ctx).some((plugin) => plugin.name === PLUGIN_NAME);
  return verdict(found ? [] : [`no plugin named ${PLUGIN_NAME}`], `marketplace lists ${PLUGIN_NAME}`);
}

function marketplaceSource(ctx: Context): Outcome {
  const problems = marketplacePlugins(ctx).flatMap((plugin) => {
    const source = text(plugin.source);
    if (source === undefined) return [];
    const allowed = ctx.marketplaceOverride ? source.startsWith("./") : source === "." || source.startsWith("./");
    return allowed ? [] : [`${text(plugin.name) ?? "plugin"} source '${source}' is not a ./ path`];
  });
  return verdict(problems, "every path source in the marketplace starts with ./");
}

function versionsEqual(ctx: Context): Outcome {
  const marketplace = asRecord(readJson(ctx.marketplacePath));
  const versions: [string, string | undefined][] = [
    [".claude-plugin/plugin.json version", text(asRecord(readJson(pluginJson(ctx))).version)],
    ["marketplace.json metadata.version", text(asRecord(marketplace.metadata).version)],
    ["marketplace.json plugins[0].version", text(asRecord(marketplacePlugins(ctx)[0]).version)],
    ["package.json version", text(asRecord(readJson(packageJson(ctx))).version)],
  ];
  const expected = versions[0]?.[1];
  const problems: string[] = [];
  if (expected === undefined || !SEMVER.test(expected)) problems.push(`plugin.json version ${JSON.stringify(expected)} is not semver`);
  for (const [label, version] of versions) {
    if (version !== expected) problems.push(`${label} is ${JSON.stringify(version)}, plugin.json says ${JSON.stringify(expected)}`);
  }
  return verdict(problems, `plugin.json, both marketplace.json fields and package.json say ${expected}`);
}

export const checks: readonly Check[] = [
  { name: "json valid", run: jsonValid },
  { name: "plugin name", run: pluginName },
  { name: "marketplace entry", run: marketplaceEntry },
  { name: "marketplace source", run: marketplaceSource },
  { name: "versions equal", run: versionsEqual },
];
