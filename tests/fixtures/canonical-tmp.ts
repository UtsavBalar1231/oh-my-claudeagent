// `bun test` preload (bunfig.toml). Windows can hand a process TEMP in its 8.3 short form (a user
// directory spelled `RUNNER~1`), while git, `realpath` and the tools under test report the long
// form, so a spec that compares a path it built under the temp directory with one the product
// printed fails on spelling alone. Resolving TEMP once, here, gives every spec and every process
// it spawns the long form.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { tmpdir } from "node:os";

const MAX_PATH_CHARS = 32_768;

if (process.platform === "win32") {
  const { symbols } = dlopen("kernel32.dll", {
    GetLongPathNameW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
  });
  const input = Buffer.from(`${tmpdir()}\0`, "utf16le");
  const output = Buffer.alloc(MAX_PATH_CHARS * 2);
  const length = symbols.GetLongPathNameW(ptr(input), ptr(output), MAX_PATH_CHARS);
  if (length === 0 || length >= MAX_PATH_CHARS) throw new Error(`GetLongPathNameW could not resolve ${tmpdir()}`);
  const long = output.toString("utf16le", 0, length * 2);
  process.env.TEMP = long;
  process.env.TMP = long;
}
