import { statSync } from "node:fs";
import { dirname } from "node:path";

const SHIPPED_ROOT = dirname(import.meta.dir);

/** `CLAUDE_PLUGIN_ROOT` when that directory exists, else the root this file ships in. */
export function pluginRoot(): string {
  const set = process.env.CLAUDE_PLUGIN_ROOT;
  return set !== undefined && statSync(set, { throwIfNoEntry: false })?.isDirectory() === true ? set : SHIPPED_ROOT;
}
