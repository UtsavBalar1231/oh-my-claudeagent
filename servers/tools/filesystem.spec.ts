import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Platform } from "../../src/core/path.ts";
import { isSensitivePath, tools } from "./filesystem.ts";

const fileRead = (() => {
  const found = tools.find((tool) => tool.name === "file_read");
  if (found === undefined) throw new Error("no tool named file_read");
  return found;
})();
const originalCwd = process.cwd();
let dir = "";

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "omca-file-read-")));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string | Uint8Array): string {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

const read = async (args: Record<string, unknown>): Promise<string> => fileRead.call(args);

const row = (number: number, text: string) => `${String(number).padStart(6)}\t${text}`;

test("file_read is declared as the only tool of the module, read-only", () => {
  expect(tools.map((tool) => tool.name)).toEqual(["file_read"]);
  expect(fileRead.annotations).toEqual({ readOnlyHint: true, idempotentHint: true, openWorldHint: false });
});

test("a short file comes back numbered with a size footer", async () => {
  const path = write("hello.txt", "line one\nline two\nline three\n");
  expect(await read({ path })).toBe(
    [row(1, "line one"), row(2, "line two"), row(3, "line three"), "", "(~7 tokens (29 B), 3 lines total)"].join("\n"),
  );
});

test("CRLF endings are stripped and a final line without a newline still counts", async () => {
  const path = write("crlf.txt", "a\r\nb");
  expect(await read({ path })).toBe([row(1, "a"), row(2, "b"), "", "(~1 tokens (4 B), 2 lines total)"].join("\n"));
});

test("offset and limit return that window and name the next offset", async () => {
  const path = write("twenty.txt", Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"));
  expect(await read({ path, offset: 5, limit: 3 })).toBe(
    [
      row(6, "line 5"),
      row(7, "line 6"),
      row(8, "line 7"),
      "",
      "(~37 tokens (149 B), 20 lines total, 12 more lines available (use offset=8 to continue))",
    ].join("\n"),
  );
});

test("a window that ends at the last line names no further offset", async () => {
  const path = write("five.txt", "a\nb\nc\nd\ne\n");
  expect(await read({ path, offset: 3, limit: 2 })).toBe([row(4, "d"), row(5, "e"), "", "(~2 tokens (10 B), 5 lines total)"].join("\n"));
});

test("limit 0 returns every line of a small file", async () => {
  const path = write("fifty.txt", Array.from({ length: 50 }, (_, index) => `entry ${index}`).join("\n"));
  const result = await read({ path, limit: 0 });
  expect(result.split("\n")[0]).toBe(row(1, "entry 0"));
  expect(result).toContain(row(50, "entry 49"));
  expect(result.endsWith("\n\n(~109 tokens (439 B), 50 lines total)")).toBe(true);
});

test("a negative offset starts at the first line", async () => {
  const path = write("neg.txt", Array.from({ length: 6 }, (_, index) => `line${index}`).join("\n"));
  expect(await read({ path, offset: -2, limit: 3 })).toBe(
    [row(1, "line0"), row(2, "line1"), row(3, "line2"), "", "(~8 tokens (35 B), 6 lines total, 3 more lines available (use offset=3 to continue))"].join("\n"),
  );
});

test("a bounded read of a 3 MB file is allowed and reports the exact line total", async () => {
  const path = write("streamed.txt", `${"z".repeat(99)}\n`.repeat(31_000));
  const lines = (await read({ path, limit: 10 })).split("\n");
  expect(lines.slice(0, 10)).toEqual(Array.from({ length: 10 }, (_, index) => row(index + 1, "z".repeat(99))));
  expect(lines.slice(10)).toEqual(["", "(~775000 tokens (3.0 MB), 31000 lines total, 30990 more lines available (use offset=10 to continue))"]);
});

test.each([0, -1])("limit %p on a file over 3 MB is refused with the rounded size", async (limit) => {
  const path = write("huge.txt", `${"y".repeat(99)}\n`.repeat(32_000));
  expect(await read({ path, limit })).toBe(
    "File too large for unlimited read: 3.1 MB (max 3.0 MB). Use offset and limit to read in chunks.",
  );
});

test("a line over 2000 characters is cut with a marker giving the dropped count", async () => {
  const path = write("minified.js", `${"q".repeat(5000)}\n`);
  expect(await read({ path })).toBe(
    [row(1, `${"q".repeat(2000)}... [line truncated, 3000 more chars]`), "", "(~1250 tokens (4.9 KB), 1 lines total)"].join("\n"),
  );
});

test("an offset past the end says so", async () => {
  const path = write("short.txt", "only one line\n");
  expect(await read({ path, offset: 100 })).toBe("(offset 100 exceeds file length of 1 lines)");
});

test("an empty file says so", async () => {
  expect(await read({ path: write("empty.txt", "") })).toBe("(empty file)");
});

test.skipIf(process.platform === "win32")("a symlink is followed to its target (skipped on Windows: creating a symlink needs a privilege)", async () => {
  const target = write("target.txt", "symlinked content\n");
  const link = join(dir, "link.txt");
  symlinkSync(target, link);
  expect(await read({ path: link })).toBe([row(1, "symlinked content"), "", "(~4 tokens (18 B), 1 lines total)"].join("\n"));
});

test("an invalid UTF-8 file falls back to latin-1 and the footer says so", async () => {
  const path = write("latin.txt", Uint8Array.of(0x63, 0x61, 0x66, 0xe9, 0x0a));
  expect(await read({ path })).toBe([row(1, "café"), "", "(~1 tokens (5 B), 1 lines total, encoding fallback: latin-1)"].join("\n"));
});

test("an unknown encoding name falls back to latin-1 too", async () => {
  const path = write("plain.txt", "plain\n");
  expect(await read({ path, encoding: "no-such-encoding" })).toBe(
    [row(1, "plain"), "", "(~1 tokens (6 B), 1 lines total, encoding fallback: latin-1)"].join("\n"),
  );
});

test("a requested encoding that decodes cleanly is used without a fallback note", async () => {
  const path = write("latin.txt", Uint8Array.of(0x63, 0x61, 0x66, 0xe9, 0x0a));
  expect(await read({ path, encoding: "iso-8859-1" })).toBe([row(1, "café"), "", "(~1 tokens (5 B), 1 lines total)"].join("\n"));
});

test("a multi-byte character split across read chunks decodes intact", async () => {
  const path = write("emoji.txt", `${"€".repeat(50_000)}\nend\n`);
  const [first, second] = (await read({ path })).split("\n");
  expect(first).toBe(row(1, "€".repeat(50_000).slice(0, 2000) + "... [line truncated, 48000 more chars]"));
  expect(second).toBe(row(2, "end"));
});

test("a missing path and a directory are refused in plain text", async () => {
  const missing = join(dir, "nonexistent.txt");
  expect(await read({ path: missing })).toBe(`File not found: ${missing}`);
  expect(await read({ path: dir })).toBe(`Path is a directory, not a file: ${dir}`);
});

test.skipIf(process.platform === "win32")("a FIFO is refused in plain text (skipped on Windows: it has no FIFOs)", async () => {
  const fifo = join(dir, "pipe");
  expect(Bun.spawnSync(["mkfifo", fifo], { env: process.env }).exitCode).toBe(0);
  expect(await read({ path: fifo })).toBe(`Not a regular file (device/pipe/socket): ${fifo}`);
});

test("a path below a regular file counts as not found", async () => {
  const file = write("plain.txt", "x\n");
  expect(await read({ path: join(file, "inside") })).toBe(`File not found: ${join(file, "inside")}`);
});

test("a null byte in the first 8 KB marks the file binary", async () => {
  const path = write("binary.bin", Uint8Array.of(0, 1, 2, 3, 0x62, 0x69, 0x6e));
  expect(await read({ path })).toBe(`Binary file detected: ${path} (7 B)`);
});

test.each([
  ".ssh/config",
  ".gnupg/pubring.kbx",
  ".aws/credentials.bak",
  ".env",
  "app/.env.local",
  "credentials.json",
  "db-secret.yaml",
  "secrets/readme.txt",
  "id_rsa",
  "keys/id_rsa.pub",
  "id_ed25519",
])("%s matches the sensitive-file denylist", async (name) => {
  const path = write(name, "hunter2\n");
  expect(await read({ path })).toBe(`Access denied: ${path} matches sensitive file pattern`);
});

test.each([".envrc", "notes.env", "credential.txt", "environment.txt", "ssh/config", "id_dsa"])("%s is not denied", async (name) => {
  const path = write(name, "fine\n");
  expect(await read({ path })).toBe([row(1, "fine"), "", "(~1 tokens (5 B), 1 lines total)"].join("\n"));
});

test.each<[Platform, string]>([
  ["win32", "C:\\Users\\x\\.ssh\\id_rsa"],
  ["win32", "C:\\Users\\x\\.aws\\credentials"],
  ["win32", "C:/Data/x/.gnupg/pubring.kbx"],
  ["win32", "C:\\proj\\.env"],
  ["win32", "C:\\proj\\app\\.env.local"],
  ["win32", "c:\\PROJ\\.ENV"],
  ["win32", "C:\\Users\\X\\.SSH\\config"],
  ["win32", "C:\\proj\\.env:Zone.Identifier"],
  ["win32", "C:\\proj\\.env::$DATA"],
  ["win32", "C:\\proj\\.env."],
  ["win32", "C:\\proj\\.env "],
  ["win32", "C:\\proj\\.ssh\\..\\.ssh\\id_rsa"],
  ["win32", "\\\\srv\\share\\.gnupg\\key"],
  ["win32", "/c/Data/x/.ssh/id_rsa"],
  ["win32", "C:\\proj\\Secrets.txt"],
  ["darwin", "/Volumes/x/.ENV"],
  ["darwin", "/Volumes/x/.SSH/id_rsa"],
  ["darwin", "/Volumes/x/AWS/.aws/Credentials"],
  ["linux", "/srv/u/.env"],
  ["linux", "/srv/u/.ssh/id_rsa"],
  ["linux", "/etc/shadow"],
])("isSensitivePath(%s, %p) is true", (platform, path) => {
  expect(isSensitivePath(platform, path)).toBe(true);
});

test.each<[Platform, string]>([
  ["win32", "C:\\proj\\src\\index.ts"],
  ["win32", "C:\\proj\\environment.txt"],
  ["win32", "C:\\Users\\x\\.sshkeys\\a"],
  ["win32", "C:\\proj\\notes:stream"],
  ["darwin", "/Volumes/x/Project/App.ts"],
  ["linux", "/srv/u/.ENV"],
  ["linux", "/srv/u/.envrc"],
  ["linux", "/etc/shadow.bak"],
])("isSensitivePath(%s, %p) is false", (platform, path) => {
  expect(isSensitivePath(platform, path)).toBe(false);
});

test.skipIf(process.platform === "win32")("a symlink is judged by the file it points at (skipped on Windows: creating a symlink needs a privilege)", async () => {
  const target = write(".env", "SECRET=hunter2\n");
  const link = join(dir, "notes.txt");
  symlinkSync(target, link);
  expect(await read({ path: link })).toBe(`Access denied: ${link} matches sensitive file pattern`);
});

test.skipIf(!existsSync("/etc/shadow"))("/etc/shadow is denied (skipped where /etc/shadow does not exist)", async () => {
  expect(await read({ path: "/etc/shadow" })).toBe("Access denied: /etc/shadow matches sensitive file pattern");
});

test("the footer's token figure is the file size over four, not the window", async () => {
  const path = write("sized.txt", `${"a".repeat(799)}\n`);
  expect((await read({ path })).endsWith("\n\n(~200 tokens (800 B), 1 lines total)")).toBe(true);
});

test("every call is logged to .omca/logs/file-access.jsonl under the working directory", async () => {
  const readable = write("readable.txt", "audit test\n");
  const denied = write(".env", "x\n");
  await read({ path: readable });
  await read({ path: denied });
  await read({ path: join(dir, "missing.txt") });
  const entries = readFileSync(join(dir, ".omca", "logs", "file-access.jsonl"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  const timestamp = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  expect(entries).toEqual([
    { path: readable, allowed: true, timestamp },
    { path: denied, allowed: false, timestamp },
    { path: join(dir, "missing.txt"), allowed: false, timestamp },
  ]);
});

test("a non-string path and a non-integer limit are rejected as errors", async () => {
  await expect(read({})).rejects.toThrow("path must be a string");
  await expect(read({ path: write("a.txt", "a\n"), limit: "5" })).rejects.toThrow("limit must be an integer");
  await expect(read({ path: write("b.txt", "b\n"), offset: 1.5 })).rejects.toThrow("offset must be an integer");
});
