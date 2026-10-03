import { lstatSync, readFileSync } from "node:fs";

export const TOKEN_FILE_ENV = "OMCA_COMPARE_TOKEN_FILE";
const REDACTED = "[redacted]";

export class TokenFileError extends Error {}

export function readTokenFile(path: string | undefined): string {
  if (path === undefined || path === "") throw new TokenFileError(`no token file: pass --token-file or set ${TOKEN_FILE_ENV}`);
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info === undefined) throw new TokenFileError(`token file ${path} does not exist`);
  if (!info.isFile()) throw new TokenFileError(`token file ${path} is not a regular file; a symlink is refused`);
  if (info.uid !== process.getuid?.()) throw new TokenFileError(`token file ${path} belongs to another user`);
  if ((info.mode & 0o077) !== 0) {
    throw new TokenFileError(`token file ${path} is readable by group or others (mode ${(info.mode & 0o777).toString(8)}); run chmod 600 on it`);
  }
  const token = readFileSync(path, "utf8").trim();
  if (token === "") throw new TokenFileError(`token file ${path} is empty`);
  if (/\s/.test(token)) throw new TokenFileError(`token file ${path} must hold the token alone, with no spaces or extra lines`);
  return token;
}

export const redact = (text: string, token: string): string => text.split(token).join(REDACTED);
