import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

export interface GitInfo {
  repo: boolean;
  branch: string;
  staged: number;
  modified: number;
  untracked: number;
  remote: string;
  remoteFetchedAt: number;
}

export interface GitOptions {
  cacheDir: string;
  ttlSeconds: number;
  timeoutMs: number;
}

export const NO_REPO: GitInfo = { repo: false, branch: "", staged: 0, modified: 0, untracked: 0, remote: "", remoteFetchedAt: 0 };

export const CACHE_TTL_SECONDS = 5;
export const GIT_TIMEOUT_MS = 3000;
const REMOTE_TTL_SECONDS = 60;

export function resolveGitDir(projectDir: string): string | null {
  const dotGit = join(projectDir, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const line = readFileSync(dotGit, "utf8").trim();
    if (!line.startsWith("gitdir: ")) return null;
    const gitDir = line.slice("gitdir: ".length);
    return isAbsolute(gitDir) ? gitDir : normalize(join(projectDir, gitDir));
  } catch {
    return null;
  }
}

export function readBranchFromHead(gitDir: string): string {
  let head: string;
  try {
    head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  } catch {
    return "";
  }
  if (head.startsWith("ref: refs/heads/")) return head.slice("ref: refs/heads/".length);
  if (head.startsWith("ref: ")) return head.slice("ref: ".length);
  return `(detached:${head.slice(0, 7)})`;
}

export function parsePorcelainV2(output: string): { staged: number; modified: number; untracked: number } {
  const counts = { staged: 0, modified: 0, untracked: 0 };
  for (const line of output.split("\n")) {
    if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const xy = line.split(" ", 2)[1] ?? "";
      if (xy.length >= 2) {
        if (xy[0] !== ".") counts.staged++;
        if (xy[1] !== ".") counts.modified++;
      }
    } else if (line.startsWith("u ")) counts.modified++;
    else if (line.startsWith("? ")) counts.untracked++;
  }
  return counts;
}

async function runGit(projectDir: string, args: string[], timeoutMs: number): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "-C", projectDir, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      timeout: timeoutMs,
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out : null;
  } catch {
    return null;
  }
}

async function fetchGitInfo(projectDir: string, timeoutMs: number, cached: GitInfo | null): Promise<GitInfo> {
  const gitDir = resolveGitDir(projectDir);
  if (gitDir === null) return NO_REPO;
  const now = Date.now() / 1000;
  const reuseRemote = cached !== null && now - cached.remoteFetchedAt < REMOTE_TTL_SECONDS;
  const [status, remote] = await Promise.all([
    runGit(projectDir, ["status", "--porcelain=v2", "-u"], timeoutMs),
    reuseRemote ? cached.remote : runGit(projectDir, ["remote", "get-url", "origin"], timeoutMs).then((out) => out?.trim() ?? ""),
  ]);
  return {
    repo: true,
    branch: readBranchFromHead(gitDir),
    ...parsePorcelainV2(status ?? ""),
    remote,
    remoteFetchedAt: reuseRemote ? cached.remoteFetchedAt : now,
  };
}

function readCache(path: string): { info: GitInfo; ageSeconds: number } | null {
  try {
    return { info: JSON.parse(readFileSync(path, "utf8")), ageSeconds: (Date.now() - statSync(path).mtimeMs) / 1000 };
  } catch {
    return null;
  }
}

export async function getGitInfo(projectDir: string, { cacheDir, ttlSeconds, timeoutMs }: GitOptions): Promise<GitInfo> {
  const key = new Bun.CryptoHasher("md5").update(projectDir).digest("hex").slice(0, 8);
  const cachePath = join(cacheDir, `omca-statusline-git-${key}`);
  const cached = readCache(cachePath);
  if (cached !== null && cached.ageSeconds < ttlSeconds) return cached.info;

  const info = await fetchGitInfo(projectDir, timeoutMs, cached?.info ?? null);
  try {
    const scratch = `${cachePath}.${process.pid}`;
    writeFileSync(scratch, JSON.stringify(info));
    renameSync(scratch, cachePath);
  } catch {
    // An unwritable cache only costs the next render a fresh git call.
  }
  return info;
}
