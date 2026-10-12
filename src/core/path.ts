export type Platform = "linux" | "darwin" | "win32";
export type Env = Readonly<Record<string, string | undefined>>;

// A drive or UNC path is Windows-shaped whatever runs the code, so a caller that only reads an
// absolute path the client sent has no platform to pass and uses this one.
export const SHAPE_PLATFORM: Platform = "linux";

const DRIVE_ROOT = /^[A-Za-z]:[\\/]/;
const MAC_ROOT = /^\/(?:Users|Volumes|private)\//;
const isWindowsShaped = (path: string): boolean => DRIVE_ROOT.test(path) || path.startsWith("\\\\");

export const toPlatform = (name: string): Platform => (name === "win32" || name === "darwin" ? name : "linux");

/** The platform the paths look like they come from, for a caller that is handed paths and no platform. */
export function inferPlatform(...paths: readonly string[]): Platform {
  if (paths.some(isWindowsShaped)) return "win32";
  return paths.some((path) => MAC_ROOT.test(path)) ? "darwin" : "linux";
}

/** Forward slashes throughout; on win32 also a Git Bash `/c/...` path becomes `c:/...`. */
export function toPosix(platform: Platform, path: string): string {
  if (platform !== "win32" && !isWindowsShaped(path)) return path;
  const slashed = path.replaceAll("\\", "/");
  return platform === "win32" ? slashed.replace(/^\/([A-Za-z])(?:\/|$)/, "$1:/") : slashed;
}

export function isAbsolutePath(platform: Platform, path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\\\") || DRIVE_ROOT.test(path) || (platform === "win32" && path.startsWith("\\"));
}

function splitRoot(posix: string): [root: string, rest: string] {
  const drive = DRIVE_ROOT.exec(posix)?.[0];
  if (drive !== undefined) return [drive, posix.slice(drive.length)];
  const unc = /^\/\/[^/]+(?:\/[^/]+)?/.exec(posix)?.[0];
  if (unc !== undefined) return [`${unc}/`, posix.slice(unc.length)];
  return posix.startsWith("/") ? ["/", posix.slice(1)] : ["", posix];
}

export function baseName(platform: Platform, path: string): string {
  const [, rest] = splitRoot(toPosix(platform, path));
  const trimmed = rest.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** Resolves `.` and `..` and collapses repeated separators, keeping the drive or UNC prefix; the result uses forward slashes. */
export function normalizePath(platform: Platform, path: string): string {
  const [root, rest] = splitRoot(toPosix(platform, path));
  const parts: string[] = [];
  for (const part of rest.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (parts.length > 0 && parts.at(-1) !== "..") parts.pop();
    else if (root === "") parts.push(part);
  }
  return root + parts.join("/") || ".";
}

export const joinPath = (platform: Platform, ...parts: readonly string[]): string =>
  normalizePath(platform, parts.filter((part) => part !== "").join("/"));

const foldDrive = (path: string): string => path.replace(/^[A-Za-z]:/, (drive) => drive.toLowerCase());
const fold = (platform: Platform, path: string): string => foldDrive(platform === "linux" ? path : path.toLowerCase());

export function samePath(platform: Platform, a: string, b: string): boolean {
  return fold(platform, normalizePath(platform, a)) === fold(platform, normalizePath(platform, b));
}

/** True for the directory itself and anything below it. */
export function isInside(platform: Platform, parent: string, child: string): boolean {
  const base = fold(platform, normalizePath(platform, parent));
  const path = fold(platform, normalizePath(platform, child));
  return path === base || path.startsWith(base.endsWith("/") ? base : `${base}/`);
}

export function tildePath(platform: Platform, path: string, home: string): string {
  if (home === "") return path;
  const root = normalizePath(platform, home);
  const full = normalizePath(platform, path);
  const isBelow = !root.endsWith("/") && fold(platform, full).startsWith(`${fold(platform, root)}/`);
  return isBelow ? `~${full.slice(root.length)}` : path;
}

/** The path with a leading `~` replaced by `home`, undefined when it starts with `~` and no home is known. */
export function expandTilde(platform: Platform, path: string, home: string | undefined): string | undefined {
  const match = (platform === "win32" ? /^~(?:[\\/](.*))?$/s : /^~(?:\/(.*))?$/s).exec(path);
  if (match === null) return path;
  return home === undefined || home === "" ? undefined : joinPath(platform, home, match[1] ?? "");
}

const set = (value: string | undefined): value is string => value !== undefined && value !== "";

/** `HOME`, then `USERPROFILE`, then `HOMEDRIVE` and `HOMEPATH`, normalized; undefined when none is set. */
export function homeDir(env: Env): string | undefined {
  const { HOME, USERPROFILE, HOMEDRIVE, HOMEPATH } = env;
  const home = set(HOME) ? HOME : set(USERPROFILE) ? USERPROFILE : set(HOMEDRIVE) && set(HOMEPATH) ? `${HOMEDRIVE}${HOMEPATH}` : undefined;
  return home === undefined ? undefined : normalizePath(SHAPE_PLATFORM, home);
}

/** `CLAUDE_CONFIG_DIR`, else `<home>/.claude`; undefined when neither resolves. */
export function configDir(env: Env): string | undefined {
  if (set(env["CLAUDE_CONFIG_DIR"])) return normalizePath(SHAPE_PLATFORM, env["CLAUDE_CONFIG_DIR"]);
  const home = homeDir(env);
  return home === undefined ? undefined : joinPath(SHAPE_PLATFORM, home, ".claude");
}
