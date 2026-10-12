import { dirname } from "node:path";
import { isDirectory } from "./io.ts";

const SHIPPED_ROOT = dirname(import.meta.dir);

/** `CLAUDE_PLUGIN_ROOT` when that directory exists, else the root this file ships in. */
export function pluginRoot(): string {
  const set = process.env.CLAUDE_PLUGIN_ROOT;
  return set !== undefined && isDirectory(set) ? set : SHIPPED_ROOT;
}
