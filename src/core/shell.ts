import type { Platform } from "./path.ts";

/**
 * What the guard knows about the session a command runs in. `home`, `cwd` and `root` are the
 * absolute paths the client reports, in whatever spelling it uses; `platform` is read from them
 * when it is absent.
 */
export type Context = {
  shell: "bash" | "powershell";
  home?: string;
  cwd?: string;
  root?: string;
  platform?: Platform;
};

export type Removal = { targets: string[] };

export const S = "[ \\t\\n\\v\\f\\r]";
export const NS = "[^ \\t\\n\\v\\f\\r]";

/** A word of a command line: quoted with spaces allowed, or bare with `\ ` for a space. */
export const ARGUMENT = `(?:"[^"\\n]*"|'[^'\\n]*'|(?:\\\\ |${NS})+)`;

/**
 * Regex source that matches `text` in any letter case. The `i` flag is no substitute: it makes a
 * pattern with the guard's long alternations take seconds to fail on a long input.
 */
export const anyCase = (text: string): string =>
  text.replace(/[A-Za-z]/g, (letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`);

/**
 * Regex source for one command word spelled any way the shell resolves it: the bare name, with
 * an `.exe` suffix, behind a path (`/usr/bin/rm`, `\rm`), or as a quoted path that holds spaces
 * (`"C:\Program Files\Git\cmd\git.exe"`). `name` may be an alternation.
 */
export function commandWord(name: string): string {
  const tail = `(?:${name})(?:\\.${anyCase("exe")})?`;
  // No command sits behind a path longer than the Windows limit of 260; the bound keeps a long
  // token from costing a backtrack per character.
  const barePath = `(?:(?:\\\\ |[^ \\t\\n\\v\\f\\r;&|()\`"'<>]){0,300}[\\\\/])?`;
  return `(?:"(?:[^"\\n]*[\\\\/])?${tail}"|'(?:[^'\\n]*[\\\\/])?${tail}'|${barePath}${tail})`;
}
