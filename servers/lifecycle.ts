import { readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { hasCode } from "./io.ts";
import { gcRegistry } from "./tools/boulder.ts";
import { rotateLedger } from "./tools/evidence.ts";

const DAY_MS = 24 * 3600 * 1000;
const RECORD_MAX_AGE_MS = 90 * DAY_MS;
const MARKER_MAX_AGE_MS = DAY_MS;
const TEMP_MAX_AGE_MS = DAY_MS;

function entriesOf(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
}

/**
 * Deletes the files under `dir` whose names end in `suffix`, one directory level deep, last written before `cutoffMs`.
 * With `dropEmpty` it also removes every subdirectory of `dir` that is empty afterwards.
 * An entry that cannot be removed, such as a file another process holds open, is logged and skipped so the rest still go.
 */
function prune(dir: string, suffix: string, cutoffMs: number, dropEmpty: boolean, depth = 1): void {
  for (const entry of entriesOf(dir)) {
    const path = join(dir, entry.name);
    try {
      if (entry.isDirectory() && depth > 0) {
        prune(path, suffix, cutoffMs, dropEmpty, depth - 1);
        if (dropEmpty && readdirSync(path).length === 0) rmdirSync(path);
      } else if (entry.isFile() && entry.name.endsWith(suffix) && statSync(path).mtimeMs < cutoffMs) {
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
    ["delegation record prune", () => prune(join(omca, "metrics"), ".json", now - RECORD_MAX_AGE_MS, true)],
    ["feedback prune", () => prune(join(omca, "feedback"), ".json", now - RECORD_MAX_AGE_MS, true)],
    ["mod marker prune", () => prune(join(omca, "state", "mod"), ".json", now - MARKER_MAX_AGE_MS, true)],
    ["session status prune", () => prune(join(omca, "state", "session"), ".json", now - MARKER_MAX_AGE_MS, true)],
    // A crash between a temp file's create and its rename leaves the temp file behind. A lock
    // directory may be empty while held, so this sweep removes no directories.
    ...["state", "evidence", "notepads"].map((dir): [string, () => unknown] => [
      `${dir} temp file sweep`,
      () => prune(join(omca, dir), ".tmp", now - TEMP_MAX_AGE_MS, false),
    ]),
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (error) {
      console.error(`omca: start-up ${name} failed:`, error);
    }
  }
}
