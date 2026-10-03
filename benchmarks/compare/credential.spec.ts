import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTokenFile, redact, TOKEN_FILE_ENV, TokenFileError } from "./credential.ts";

const POSIX = process.platform !== "win32";
const FAKE_TOKEN = "fake-oauth-token-for-specs";
const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "compare-token-"));
  dirs.push(dir);
  return dir;
};
const tokenFile = (content: string, mode: number): string => {
  const path = join(scratch(), "token");
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
};
const refusal = (path: string | undefined): string => {
  try {
    readTokenFile(path);
  } catch (error) {
    expect(error).toBeInstanceOf(TokenFileError);
    return (error as Error).message;
  }
  throw new Error("the token file was accepted");
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readTokenFile", () => {
  test.skipIf(!POSIX)("returns the trimmed token of a 0600 file", () => {
    expect(readTokenFile(tokenFile(`${FAKE_TOKEN}\n`, 0o600))).toBe(FAKE_TOKEN);
  });

  test("names the flag and the variable when no path is given", () => {
    expect(refusal(undefined)).toBe(`no token file: pass --token-file or set ${TOKEN_FILE_ENV}`);
    expect(refusal("")).toContain("--token-file");
  });

  test("refuses a missing file", () => {
    const path = join(scratch(), "absent");
    expect(refusal(path)).toBe(`token file ${path} does not exist`);
  });

  test.skipIf(!POSIX)("refuses a file that group or others can read", () => {
    for (const mode of [0o640, 0o604, 0o644, 0o660]) {
      const path = tokenFile(FAKE_TOKEN, mode);
      expect(refusal(path)).toBe(`token file ${path} is readable by group or others (mode ${mode.toString(8)}); run chmod 600 on it`);
    }
  });

  test.skipIf(!POSIX)("refuses a symlink even when its target is private", () => {
    const target = tokenFile(FAKE_TOKEN, 0o600);
    const link = join(scratch(), "link");
    symlinkSync(target, link);
    expect(refusal(link)).toBe(`token file ${link} is not a regular file; a symlink is refused`);
  });

  test.skipIf(!POSIX)("refuses a directory", () => {
    const dir = scratch();
    expect(refusal(dir)).toContain("is not a regular file");
  });

  test.skipIf(!POSIX)("refuses an empty file and a file with more than the token", () => {
    expect(refusal(tokenFile("\n", 0o600))).toContain("is empty");
    expect(refusal(tokenFile(`${FAKE_TOKEN}\nsecond line\n`, 0o600))).toContain("must hold the token alone");
  });

  test.skipIf(!POSIX)("never puts the token in a refusal message", () => {
    const messages = [refusal(tokenFile(FAKE_TOKEN, 0o644)), refusal(tokenFile(`${FAKE_TOKEN} extra`, 0o600))];
    for (const message of messages) expect(message).not.toContain(FAKE_TOKEN);
  });
});

describe("redact", () => {
  test("replaces every occurrence", () => {
    expect(redact(`a ${FAKE_TOKEN} b ${FAKE_TOKEN}`, FAKE_TOKEN)).toBe("a [redacted] b [redacted]");
  });

  test("leaves text without the token alone", () => {
    expect(redact("nothing here", FAKE_TOKEN)).toBe("nothing here");
  });
});
