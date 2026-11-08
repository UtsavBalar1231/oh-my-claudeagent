import { inferPlatform } from "../src/core/path.ts";
import type { Host } from "./host.ts";

const GIT_TIMEOUT_MS = 5000;

const roots = new Map<string, Promise<string>>();

async function topLevel(started: string, run: Host["process"]["run"]): Promise<string> {
  try {
    const { exitCode, stdout } = await run(["git", "rev-parse", "--show-toplevel"], { cwd: started, timeoutMs: GIT_TIMEOUT_MS });
    const top = stdout.trim();
    if (exitCode !== 0 || top === "") return started;
    return inferPlatform(started, top) === "win32" ? top.replaceAll("/", "\\") : top;
  } catch {
    return started;
  }
}

/** The repository top level of `started`, or `started` itself outside a repository or when git fails. */
export function projectRoot(started: string, run: Host["process"]["run"]): Promise<string> {
  let root = roots.get(started);
  if (root === undefined) {
    root = topLevel(started, run);
    roots.set(started, root);
  }
  return root;
}
