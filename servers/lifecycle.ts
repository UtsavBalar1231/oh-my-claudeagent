import { readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { gcRegistry } from "./tools/boulder.ts";
import { rotateLedger } from "./tools/evidence.ts";

const DAY_MS = 24 * 3600 * 1000;
const RECORD_MAX_AGE_MS = 90 * DAY_MS;
const MARKER_MAX_AGE_MS = DAY_MS;

function entriesOf(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Deletes the `.json` files under `dir`, one directory level deep, last written before `cutoffMs`, and the directories that leaves empty.
 * An entry that cannot be removed, such as a file another process holds open, is logged and skipped so the rest still go.
 */
function pruneJson(dir: string, cutoffMs: number, depth = 1): void {
  for (const entry of entriesOf(dir)) {
    const path = join(dir, entry.name);
    try {
      if (entry.isDirectory() && depth > 0) {
        pruneJson(path, cutoffMs, depth - 1);
        if (readdirSync(path).length === 0) rmdirSync(path);
      } else if (entry.isFile() && entry.name.endsWith(".json") && statSync(path).mtimeMs < cutoffMs) {
        rmSync(path, { force: true });
      }
    } catch (error) {
      console.error(`omca: start-up prune left ${path}:`, error);
    }
  }
}

/** The server's start-up housekeeping. Each step logs its own failure and the rest still run. */
export async function startWork(root: string, now = Date.now()): Promise<void> {
  const omca = join(root, ".omca");
  const steps: Array<[string, () => unknown]> = [
    ["plan registry GC", () => gcRegistry(root)],
    ["evidence ledger rotation", () => rotateLedger(root, new Date(now))],
    ["delegation record prune", () => pruneJson(join(omca, "metrics"), now - RECORD_MAX_AGE_MS)],
    ["feedback prune", () => pruneJson(join(omca, "feedback"), now - RECORD_MAX_AGE_MS)],
    ["mod marker prune", () => pruneJson(join(omca, "state", "mod"), now - MARKER_MAX_AGE_MS)],
    ["session status prune", () => pruneJson(join(omca, "state", "session"), now - MARKER_MAX_AGE_MS)],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (error) {
      console.error(`omca: start-up ${name} failed:`, error);
    }
  }
}
