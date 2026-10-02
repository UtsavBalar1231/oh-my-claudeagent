import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const configDir = process.env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude");
const cache = join(configDir, "plugins", "cache", "omca", "oh-my-claudeagent");
const subagent = process.argv.includes("--subagent");

let entries: string[] = [];
try {
  entries = readdirSync(cache);
} catch {}
const version = entries.filter((entry) => /^\d+\.\d+\.\d+$/.test(entry)).sort(Bun.semver.order).at(-1);

if (version !== undefined) await import(pathToFileURL(join(cache, version, "statusline", subagent ? "subagent.ts" : "main.ts")).href);
else if (!subagent) console.log("omca: no installed plugin version found");
