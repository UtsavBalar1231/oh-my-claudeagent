import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const configDir = process.env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude");
const entry = process.argv.includes("--subagent") ? "subagent.ts" : "main.ts";

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function readJson(path: string): Json {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

// Claude Code's own registry says where each install of the plugin lives, under any marketplace
// and any version string; an install switched off in the user's settings is passed over.
const settings = readJson(join(configDir, "settings.json"));
const enabled = isRecord(settings["enabledPlugins"]) ? settings["enabledPlugins"] : {};
const registry = readJson(join(configDir, "plugins", "installed_plugins.json"));
const plugins = isRecord(registry["plugins"]) ? registry["plugins"] : {};

const installs = Object.entries(plugins)
  .filter(([id]) => id.startsWith("oh-my-claudeagent@") && enabled[id] !== false)
  .flatMap(([, list]) => (Array.isArray(list) ? list : []))
  .flatMap((install) =>
    isRecord(install) && typeof install["installPath"] === "string"
      ? [{ path: install["installPath"], updated: typeof install["lastUpdated"] === "string" ? install["lastUpdated"] : "" }]
      : [],
  )
  .filter(({ path }) => existsSync(join(path, "statusline", entry)))
  .sort((a, b) => b.updated.localeCompare(a.updated));

const chosen = installs[0];
if (chosen !== undefined) await import(pathToFileURL(join(chosen.path, "statusline", entry)).href);
else if (entry === "main.ts") console.log("omca: no installed plugin version found");
