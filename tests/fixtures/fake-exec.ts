import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Writes a program named `name` into `dir` whose body is the JavaScript `source`, run by bun, and
 * returns its path. POSIX gets an executable script with bun as its interpreter. Windows cannot
 * run a shebang, and the ast-grep resolver rejects `.cmd` shims, so there it is a bun-compiled
 * `.exe`.
 */
export function fakeExec(dir: string, name: string, source: string): string {
  if (process.platform !== "win32") {
    const path = join(dir, name);
    writeFileSync(path, `#!${process.execPath}\n${source}\n`);
    chmodSync(path, 0o755);
    return path;
  }
  const script = join(dir, `${name}.fake.ts`);
  const path = join(dir, `${name}.exe`);
  writeFileSync(script, source);
  const built = Bun.spawnSync([process.execPath, "build", "--compile", script, "--outfile", path], { env: process.env, stdout: "pipe", stderr: "pipe" });
  if (built.exitCode !== 0) throw new Error(`could not compile ${name}: ${built.stderr.toString()}`);
  return path;
}
