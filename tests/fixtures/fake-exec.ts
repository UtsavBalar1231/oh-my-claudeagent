import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BUSY = new Set(["EBUSY", "EPERM"]);

/**
 * Removes a directory that held a fake executable. Windows keeps an exited program's `.exe`
 * locked while a handle to its process is open, and bun closes that handle only when the
 * subprocess object is collected, so a busy removal collects garbage and waits on the event loop
 * before it tries again, for about five seconds before it gives up and throws.
 */
export async function removeExecDir(dir: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (attempt >= 50 || typeof code !== "string" || !BUSY.has(code)) throw error;
      Bun.gc(true);
      await Bun.sleep(100);
    }
  }
}

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
