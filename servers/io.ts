import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

// `!/rules/` alone re-includes the directory but `*` still matches every file inside it.
const OMCA_GITIGNORE = "*\n!/rules/\n!/rules/**\n";
export const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;

// Windows reports a file another process holds open, often a virus scanner or an indexer, as one
// of these until the holder lets go. Ten tries with 5 to 50 ms backoff spans about 0.3 s.
const BUSY_CODES: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "EACCES"]);
const BUSY_TRIES = 10;
const BUSY_BACKOFF_MIN_MS = 5;
const BUSY_BACKOFF_MAX_MS = 50;

// FAT, exFAT, SMB and some FUSE mounts cannot hard-link.
const LINK_UNSUPPORTED_CODES: ReadonlySet<string> = new Set(["EPERM", "ENOSYS", "EOPNOTSUPP", "EINVAL"]);

const LOCK_HOST = hostname().replace(/\s+/g, "_") || "unknown";
const LOCK_FORMAT = /^([1-9]\d*) (\d+) \S+(?: (\S+))?$/;

export const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;

export const hasCode = (error: unknown, code: string): boolean => errorCode(error) === code;

/** True when the path, or a directory on the way to it, does not exist. */
export const isMissing = (error: unknown): boolean => hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR");

const isIn = (codes: ReadonlySet<string>, error: unknown): boolean => {
  const code = errorCode(error);
  return code !== undefined && codes.has(code);
};

// Another process holding a file open never blocks creating a new one, so a permission error from
// creating the lock's temp file or directory is final, never busy.
const refusedCreates = new WeakSet<Error>();
function create(make: () => void): void {
  try {
    make();
  } catch (error) {
    if (error instanceof Error) refusedCreates.add(error);
    throw error;
  }
}

const tempPath = (path: string) => `${path}.${crypto.randomUUID()}.tmp`;

function retryBusy<T>(operation: () => T): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return operation();
    } catch (error) {
      if (attempt === BUSY_TRIES || !isIn(BUSY_CODES, error)) throw error;
      Bun.sleepSync(Math.min(BUSY_BACKOFF_MAX_MS, BUSY_BACKOFF_MIN_MS * 2 ** (attempt - 1)));
    }
  }
}

/** Runs cleanup that must never replace the result or error of the work it follows. */
function bestEffort(what: string, cleanup: () => void): void {
  try {
    cleanup();
  } catch (error) {
    console.error(`omca: ${what} failed:`, error);
  }
}

const removeFile = (path: string): void => retryBusy(() => rmSync(path, { force: true }));

const NOT_A_REPOSITORY = /not a git repository/i;

// A directory's top level holds for the server's life, and a git spawn blocks the thread (about
// 110 ms on Windows), so each directory resolves, and reports a failure, once.
const roots = new Map<string, string>();

export function projectRoot(dir: string): string {
  let root = roots.get(dir);
  if (root === undefined) {
    root = findRoot(dir);
    roots.set(dir, root);
  }
  return root;
}

function findRoot(dir: string): string {
  try {
    const git = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      cwd: dir,
      env: process.env,
      stderr: "pipe",
      timeout: 5_000,
      windowsHide: true,
    });
    const top = git.stdout.toString().trim();
    if (git.exitCode === 0 && top !== "") return resolve(top);
    const detail = git.stderr.toString().trim();
    if (detail !== "" && !NOT_A_REPOSITORY.test(detail)) console.error(`omca: git rev-parse --show-toplevel failed in ${dir}; using it as the project root: ${detail}`);
    return dir;
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    console.error(`omca: could not run git in ${dir}; using it as the project root:`, error);
    return dir;
  }
}

export const isDirectory = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;

export function ensureStateDir(root: string): string {
  const stateDir = join(root, ".omca", "state");
  mkdirSync(stateDir, { recursive: true });
  const gitignore = join(root, ".omca", ".gitignore");
  if (readOrNull(gitignore) !== OMCA_GITIGNORE) writeFileAtomic(gitignore, OMCA_GITIGNORE);
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
    retryBusy(() => renameSync(temp, path));
  } catch (error) {
    bestEffort(`removing ${temp}`, () => removeFile(temp));
    throw error;
  }
}

export function readOrNull(path: string): string | null {
  try {
    return retryBusy(() => readFileSync(path, "utf8"));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

/** Returns whether the file existed. */
function unlinkOrGone(path: string): boolean {
  try {
    retryBusy(() => unlinkSync(path));
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

const directoryOf = (lockPath: string) => `${lockPath}.d`;
const ownerOf = (lockPath: string) => join(directoryOf(lockPath), "owner");

// A directory made with mkdir is atomic everywhere. The token reaches it by rename, so the owner
// file appears with its content in place, as a linked lock file does.
function takeDirectory(temp: string, lockPath: string): boolean {
  const directory = directoryOf(lockPath);
  try {
    create(() => mkdirSync(directory));
  } catch (error) {
    if (hasCode(error, "EEXIST")) return false;
    throw error;
  }
  try {
    retryBusy(() => renameSync(temp, ownerOf(lockPath)));
  } catch (error) {
    bestEffort(`removing ${directory}`, () => retryBusy(() => rmSync(directory, { recursive: true, force: true })));
    throw error;
  }
  return true;
}

// A linked file appears with its content already in place; a waiter reading a lock created
// with open('wx') then written can see it empty and break a held lock.
function tryTake(lockPath: string, content: string): boolean {
  const temp = tempPath(lockPath);
  create(() => writeFileSync(temp, content, { flag: "wx" }));
  try {
    linkSync(temp, lockPath);
    return true;
  } catch (error) {
    // A link whose reply was lost (NFS) reports EEXIST although it was made.
    if (hasCode(error, "EEXIST")) return statSync(temp).nlink === 2;
    if (isIn(LINK_UNSUPPORTED_CODES, error)) return takeDirectory(temp, lockPath);
    throw error;
  } finally {
    bestEffort(`removing ${temp}`, () => removeFile(temp));
  }
}

function drop(lockPath: string): void {
  if (!unlinkOrGone(lockPath)) retryBusy(() => rmSync(directoryOf(lockPath), { recursive: true, force: true }));
}

function holderOf(lockPath: string): string | null {
  return readOrNull(lockPath) ?? readOrNull(ownerOf(lockPath));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

// A pid means nothing on another machine, so a holder on another host is judged by age alone.
function isStale(content: string): boolean {
  const match = LOCK_FORMAT.exec(content);
  if (!match) return true;
  const [, pid = "", at = "", host] = match;
  return Date.now() - Number(at) > LOCK_STALE_MS || (host === LOCK_HOST && !pidAlive(Number(pid)));
}

function inspect(lockPath: string): "free" | "held" | "stale" {
  const file = readOrNull(lockPath);
  if (file !== null) return isStale(file) ? "stale" : "held";
  const owner = readOrNull(ownerOf(lockPath));
  if (owner !== null && LOCK_FORMAT.test(owner)) return isStale(owner) ? "stale" : "held";
  const directory = statSync(directoryOf(lockPath), { throwIfNoEntry: false });
  if (directory === undefined) return "free";
  // Between mkdir and the owner file's arrival the directory is the only evidence of a holder.
  return Date.now() - directory.mtimeMs > LOCK_STALE_MS ? "stale" : "held";
}

function breakStale(lockPath: string): boolean {
  const breakPath = `${lockPath}.break`;
  const token = `${process.pid} ${Date.now()} ${crypto.randomUUID()} ${LOCK_HOST}`;
  if (!tryTake(breakPath, token)) {
    if (inspect(breakPath) === "stale") drop(breakPath);
    return false;
  }
  try {
    if (inspect(lockPath) === "stale") drop(lockPath);
  } finally {
    bestEffort(`releasing ${breakPath}`, () => drop(breakPath));
  }
  return true;
}

function tryAcquire(lockPath: string, nonce: string): string | undefined {
  try {
    for (;;) {
      const held = `${process.pid} ${Date.now()} ${nonce} ${LOCK_HOST}`;
      if (tryTake(lockPath, held)) return held;
      if (inspect(lockPath) !== "stale" || !breakStale(lockPath)) return undefined;
    }
  } catch (error) {
    if (isIn(BUSY_CODES, error) && !(error instanceof Error && refusedCreates.has(error))) return undefined;
    throw error;
  }
}

function release(lockPath: string, held: string): void {
  bestEffort(`releasing ${lockPath}`, () => {
    if (holderOf(lockPath) === held) drop(lockPath);
    else console.error(`omca: ${lockPath} no longer holds this holder's token; left in place`);
  });
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
