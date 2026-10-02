import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const OMCA_GITIGNORE = "*\n!/rules/\n";
export const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;

const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

const tempPath = (path: string) => `${path}.${crypto.randomUUID()}.tmp`;

export function projectRoot(dir: string): string {
  try {
    const git = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: dir, stderr: "ignore", timeout: 5_000 });
    const top = git.stdout.toString().trim();
    return git.exitCode === 0 && top !== "" ? top : dir;
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    console.error(`omca: could not run git in ${dir}; using it as the project root:`, error);
    return dir;
  }
}

export function ensureStateDir(root: string): string {
  const stateDir = join(root, ".omca", "state");
  mkdirSync(stateDir, { recursive: true });
  try {
    writeFileSync(join(root, ".omca", ".gitignore"), OMCA_GITIGNORE, { flag: "wx" });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  return stateDir;
}

export function writeFileAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = tempPath(path);
  try {
    const fd = openSync(temp, "wx");
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

function unlinkOrGone(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

// A linked file appears with its content already in place; a waiter reading a lock created
// with open('wx') then written can see it empty and break a held lock.
function tryLink(path: string, content: string): boolean {
  const temp = tempPath(path);
  writeFileSync(temp, content, { flag: "wx" });
  try {
    linkSync(temp, path);
    return true;
  } catch (error) {
    if (hasCode(error, "EEXIST")) return false;
    throw error;
  } finally {
    unlinkSync(temp);
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

function isStale(content: string): boolean {
  const match = /^([1-9]\d*) (\d+) \S+$/.exec(content);
  if (!match) return true;
  return !pidAlive(Number(match[1])) || Date.now() - Number(match[2]) > LOCK_STALE_MS;
}

function breakStale(lockPath: string): boolean {
  const breakPath = `${lockPath}.break`;
  const token = `${process.pid} ${Date.now()} ${crypto.randomUUID()}`;
  if (!tryLink(breakPath, token)) {
    const holder = readOrNull(breakPath);
    if (holder !== null && isStale(holder)) unlinkOrGone(breakPath);
    return false;
  }
  try {
    const current = readOrNull(lockPath);
    if (current !== null && isStale(current)) unlinkOrGone(lockPath);
  } finally {
    unlinkSync(breakPath);
  }
  return true;
}

function tryAcquire(lockPath: string, nonce: string): string | undefined {
  for (;;) {
    const held = `${process.pid} ${Date.now()} ${nonce}`;
    if (tryLink(lockPath, held)) return held;
    const current = readOrNull(lockPath);
    if (current === null || !isStale(current) || !breakStale(lockPath)) return undefined;
  }
}

function release(lockPath: string, held: string): void {
  if (readOrNull(lockPath) === held) unlinkSync(lockPath);
  else console.error(`omca: ${lockPath} no longer holds this holder's token; left in place`);
}

export async function withLock<T>(
  lockPath: string,
  fn: () => T | Promise<T>,
  timeoutMs = LOCK_TIMEOUT_MS,
): Promise<T> {
  mkdirSync(dirname(lockPath), { recursive: true });
  const nonce = crypto.randomUUID();
  const deadline = Date.now() + timeoutMs;
  let held: string | undefined;
  while ((held = tryAcquire(lockPath, nonce)) === undefined) {
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${lockPath}`);
    await Bun.sleep(1 + Math.random() * 4);
  }
  try {
    return await fn();
  } finally {
    release(lockPath, held);
  }
}

/** Runs `fn` under the lock if it can be taken within `waitMs`; returns false, having run nothing, when it cannot. */
export function tryWithLockSync(lockPath: string, fn: () => void, waitMs: number): boolean {
  const nonce = crypto.randomUUID();
  const deadline = Date.now() + waitMs;
  let held: string | undefined;
  while ((held = tryAcquire(lockPath, nonce)) === undefined) {
    if (Date.now() >= deadline) return false;
    Bun.sleepSync(1);
  }
  try {
    fn();
    return true;
  } finally {
    release(lockPath, held);
  }
}
