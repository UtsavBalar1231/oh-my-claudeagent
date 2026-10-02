import { readConfig } from "./config.ts";
import { getGitInfo, NO_REPO } from "./git.ts";
import { FALLBACK, type Payload, projectDirOf, render } from "./render.ts";
import { tmpdir } from "node:os";

async function statusline(): Promise<string> {
  try {
    const data: Payload = JSON.parse(await Bun.stdin.text());
    if (Object.keys(data.model ?? {}).length === 0) return FALLBACK;
    const config = readConfig(process.env);
    const projectDir = projectDirOf(data);
    const git = projectDir
      ? await getGitInfo(projectDir, { cacheDir: tmpdir(), ttlSeconds: config.cacheTtlSeconds, timeoutMs: config.gitTimeoutMs })
      : NO_REPO;
    return render(data, git, process.env, new Date());
  } catch {
    return FALLBACK;
  }
}

console.log(await statusline());
