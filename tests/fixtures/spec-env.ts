import { copyFileSync, symlinkSync } from "node:fs";

const WINDOWS = process.platform === "win32";

export const BUN_NAME = WINDOWS ? "bun.exe" : "bun";

const sameName = (a: string, b: string): boolean => (WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b);

/** The live process environment with `overrides` applied; an `undefined` value removes the name. A name matches an existing key case-insensitively on Windows, so `PATH` replaces `Path` instead of sitting beside it. */
export function specEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  for (const [name, value] of Object.entries(overrides)) {
    for (const key of Object.keys(env)) if (sameName(key, name)) delete env[key];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** `os.homedir()` reads HOME on POSIX and USERPROFILE on Windows, so a spec that fakes a home sets both. */
export const homeEnv = (home: string): Record<string, string> => ({ HOME: home, USERPROFILE: home });

/** Windows refuses a symlink without a privilege (EPERM), so the target is copied instead. */
export function symlinkOrCopy(target: string, path: string): void {
  try {
    symlinkSync(target, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    copyFileSync(target, path);
  }
}

/** Sets PATH in this process under whichever case the platform already uses (`Path` on Windows). */
export function setPath(value: string): void {
  const key = Object.keys(process.env).find((name) => sameName(name, "PATH")) ?? "PATH";
  process.env[key] = value;
}

/** `os.tmpdir()` reads TMPDIR on POSIX and TEMP or TMP on Windows. */
export const tmpEnv = (dir: string): Record<string, string> => ({ TMPDIR: dir, TEMP: dir, TMP: dir });
