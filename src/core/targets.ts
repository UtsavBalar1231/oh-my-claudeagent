import { inferPlatform, isAbsolutePath, isInside, joinPath, normalizePath, type Platform, samePath } from "./path.ts";
import type { Context } from "./shell.ts";

const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const VARIABLE = new RegExp(`^(?:\\$\\{(?:env:)?(${NAME})\\}|\\$(?:env:)?(${NAME})|%(${NAME})%)(.*)$`, "s");
const HOME_NAMES = new Set(["HOME", "USERPROFILE", "HOMEPATH"]);
// A variable the platform or the CI runner always sets, so a path under it is a real directory
// and not the root it reads as when the variable is empty.
const ALWAYS_SET = /^(?:TMPDIR|TEMP|TMP|RUNNER_TEMP|XDG_[A-Z0-9_]+)$/;
// Always set on Windows and holding every app's per-user data: the folder or all of its contents
// is a loss, a named folder inside it is not.
const USER_DATA = /^(?:APPDATA|LOCALAPPDATA)$/;
const SEPARATED = /^(?:[\\/].*)?$/s;
const CLIMBS = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
const GLOB = /^(?:\*|\.\*)$/;
const TRAILING_GLOBS = /(?:\/(?:\*|\.\*))+\/*$/;
// Drive mounts as each platform spells them: Git Bash and Cygwin on Windows, WSL's /mnt on
// Linux, volumes on macOS.
const MOUNTS: Readonly<Record<Platform, RegExp>> = {
  win32: /^\/(?:cygdrive|mnt)\/[A-Za-z](?=\/|$)/,
  linux: /^\/mnt\/[A-Za-z](?=\/|$)/,
  darwin: /^\/Volumes\/[^/]+(?=\/|$)/,
};

// The working directory is never empty in a running shell, so a path under one of these is the
// project's own and the reference alone is the directory itself.
const CWD_REFERENCE: Readonly<Record<Context["shell"], RegExp>> = {
  bash: /^(?:\$PWD|\$\{PWD\}|\$\(\s*pwd\s*\)|`\s*pwd\s*`)((?:[\\/].*)?)$/s,
  powershell: /^(?:\$pwd|\$\{pwd\}|\$?\(\s*(?:get-location|pwd)\s*\))((?:[\\/].*)?)$/is,
};
/** The substitutions that read as the working directory; any other `$(...)` in a target is unknown. */
export const CWD_SUBSTITUTION: Readonly<Record<Context["shell"], RegExp>> = {
  bash: /\$\(\s*pwd\s*\)|`\s*pwd\s*`/g,
  powershell: /\$\(\s*(?:get-location|pwd)\s*\)/gi,
};

type Reference = { name: string; rest: string };

function variableAt(text: string): Reference | undefined {
  const match = VARIABLE.exec(text);
  if (match === null) return undefined;
  return { name: (match[1] ?? match[2] ?? match[3] ?? "").toUpperCase(), rest: match[4] ?? "" };
}

/**
 * What follows a home reference (`~`, `$HOME`, `${HOME}`, `$env:USERPROFILE`, `%USERPROFILE%`,
 * `$HOMEDRIVE$HOMEPATH` and their spellings), or undefined when the target does not start with
 * one. `~user` counts only with `anyUser`.
 */
export function homeRest(target: string, anyUser = false): string | undefined {
  const tilde = /^~([^/\\]*)([\\/].*)?$/s.exec(target);
  if (tilde !== null) return anyUser || tilde[1] === "" ? (tilde[2] ?? "") : undefined;
  const first = variableAt(target);
  if (first === undefined) return undefined;
  const second = first.name === "HOMEDRIVE" ? variableAt(first.rest) : undefined;
  const { name, rest } = second?.name === "HOMEPATH" ? second : first;
  return HOME_NAMES.has(name) && SEPARATED.test(rest) ? rest : undefined;
}

export const platformOf = (ctx: Context): Platform =>
  ctx.platform ?? inferPlatform(...[ctx.home, ctx.cwd, ctx.root].filter((path): path is string => path !== undefined));

/** The parts below a base. `..` climbs, and stops at the root of a rooted base; a trailing glob is its parent's contents. */
function partsBelow(rest: string, isRooted: boolean): string[] {
  const kept: string[] = [];
  for (const part of rest.split(/[\\/]/)) {
    if (part === "" || part === ".") continue;
    if (part !== "..") kept.push(part);
    else if (kept.length > 0 && kept.at(-1) !== "..") kept.pop();
    else if (!isRooted) kept.push("..");
  }
  while (GLOB.test(kept.at(-1) ?? "")) kept.pop();
  return kept;
}

const countBelow = (platform: Platform, base: string, path: string): number =>
  normalizePath(platform, path).slice(normalizePath(platform, base).length).split("/").filter(Boolean).length;

function isCatastrophicPath(text: string, ctx: Context): boolean {
  const platform = platformOf(ctx);
  const stripped = text.replace(TRAILING_GLOBS, "");
  const path = normalizePath(platform, stripped === "" ? "/" : /^[A-Za-z]:$/.test(stripped) ? `${stripped}/` : stripped);
  const unc = /^\/\/[^/]+(?:\/[^/]+)?/.exec(path)?.[0];
  const drive = /^[A-Za-z]:\//.exec(path)?.[0];
  const base = unc ?? drive ?? MOUNTS[platform].exec(path)?.[0] ?? "/";
  const floor = unc === undefined ? 1 : 0;
  if (path.slice(base.length).split("/").filter(Boolean).length <= floor) return true;
  const guarded = [ctx.cwd, ctx.root].filter((dir): dir is string => dir !== undefined && isAbsolutePath(platform, dir));
  if (guarded.some((dir) => isInside(platform, path, dir))) return true;
  const { home } = ctx;
  if (home === undefined || !isAbsolutePath(platform, home)) return false;
  if (isInside(platform, path, home)) return true;
  return isInside(platform, home, path) && countBelow(platform, home, path) <= 1;
}

/**
 * A relative target resolved against the working directory. Strictly below it, the target is the
 * project's own to remove whatever the depth of the directory it sits in; anywhere else it is
 * judged as the absolute path it names.
 */
function isCatastrophicRelative(text: string, ctx: Context): boolean {
  const { cwd } = ctx;
  const platform = platformOf(ctx);
  if (cwd === undefined || !isAbsolutePath(platform, cwd)) return false;
  const path = joinPath(platform, cwd, text);
  const bare = path.replace(TRAILING_GLOBS, "");
  if (isInside(platform, cwd, bare) && !samePath(platform, cwd, bare)) return false;
  return isCatastrophicPath(path, ctx);
}

/**
 * Only a target whose loss is machine-wide is catastrophic: a filesystem or drive root, a share
 * root, a mount and the folders directly under it, home, the working directory or a parent of
 * either, and anything directly under the root or home. A leading variable reads as empty,
 * since `rm -rf "$DIR/"*` with DIR unset is the classic way to reach `/`, unless the platform
 * always sets it. A trailing glob removes its parent's contents, which is the parent's loss.
 */
export function isCatastrophicTarget(word: string, ctx: Context): boolean {
  const home = homeRest(word, true);
  if (home !== undefined) return partsBelow(home, true).length <= 1;
  const here = CWD_REFERENCE[ctx.shell].exec(word)?.[1];
  if (here !== undefined) {
    const relative = ctx.shell === "powershell" ? here.replaceAll("\\", "/") : here;
    return partsBelow(relative, false).every((part) => part === "..") || isCatastrophicRelative(relative, ctx);
  }
  const variable = variableAt(word);
  if (variable !== undefined) {
    const { name, rest } = variable;
    if (USER_DATA.test(name) && !CLIMBS.test(rest)) return SEPARATED.test(rest) && partsBelow(rest, true).length === 0;
    if (!/^[\\/]/.test(rest)) return false;
    if (ALWAYS_SET.test(name) && !CLIMBS.test(rest)) return false;
    return partsBelow(rest, true).length <= 1;
  }
  const slashed = ctx.shell === "powershell" || inferPlatform(word) === "win32" ? word.replaceAll("\\", "/") : word;
  const text = /^[A-Za-z]:$/.test(slashed) ? `${slashed}/` : slashed;
  if (text.startsWith("/") || /^[A-Za-z]:\//.test(text)) return isCatastrophicPath(text, ctx);
  return partsBelow(text, false).every((part) => part === "..") || isCatastrophicRelative(text, ctx);
}
