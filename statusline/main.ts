import { tmpdir } from "node:os";
import { CACHE_TTL_SECONDS, getGitInfo, GIT_TIMEOUT_MS, NO_REPO } from "./git.ts";
import { FALLBACK, type Payload, projectDirOf, render } from "./render.ts";

async function statusline(): Promise<string> {
  try {
    const data: Payload = JSON.parse(await Bun.stdin.text());
    if (Object.keys(data.model ?? {}).length === 0) return FALLBACK;
    const projectDir = projectDirOf(data);
    const git = projectDir
      ? await getGitInfo(projectDir, { cacheDir: tmpdir(), ttlSeconds: CACHE_TTL_SECONDS, timeoutMs: GIT_TIMEOUT_MS })
      : NO_REPO;
    return render(data, git, process.env, new Date());
  } catch {
    return FALLBACK;
  }
}

console.log(await statusline());
