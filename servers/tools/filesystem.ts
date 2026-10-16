import { appendFileSync, closeSync, createReadStream, mkdirSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { expandTilde, normalizePath, type Platform, toPlatform } from "../../src/core/path.ts";
import { isMissing, projectRoot } from "../io.ts";
import type { Tool } from "../omca.ts";
import { IDLE_CONTEXT, type ToolContext } from "../progress.ts";
import { type Args, integerArg, isoTimestamp, stringArg } from "./args.ts";

const DEFAULT_LIMIT = 1000;
const DEFAULT_BUDGET_CHARS = 40_000;
const MAX_UNLIMITED_BYTES = 3 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;
// A minified bundle is one line; without a cap a single line can outweigh the whole read.
const MAX_LINE_CHARS = 2000;
// An explicit limit can reach 10M characters in theory. 200,000 covers a normal source file whole,
// so ordinary reads are not spilled to disk, and stays under the client's ceiling.
const MAX_RESULT_CHARS = 200_000;
const AUDIT_LOG = join(".omca", "logs", "file-access.jsonl");
const PLATFORM = toPlatform(process.platform);
const SENSITIVE_PATH = /\/\.(?:ssh|gnupg|aws)\/|\/\.env(?:$|\.)|\/(?:credentials|id_rsa|id_ed25519)|secret|^\/etc\/g?shadow$/i;

type Decoder = { decode(chunk?: Buffer, options?: { stream: boolean }): string };

const LATIN1: Decoder = { decode: (chunk) => chunk?.toString("latin1") ?? "" };

/**
 * Yields the lines of a file without holding more than one decoded chunk and the unfinished line.
 * With `maxLineChars` a longer line is cut there while it streams, and carries a marker naming the
 * characters dropped.
 */
export async function* readLines(path: string, decoder: Decoder, maxLineChars = Number.POSITIVE_INFINITY, signal?: AbortSignal): AsyncGenerator<string> {
  signal?.throwIfAborted();
  let kept = "";
  let dropped = 0;
  let last = "";
  const add = (piece: string): void => {
    if (piece === "") return;
    last = piece.slice(-1);
    const room = maxLineChars - kept.length;
    kept += piece.slice(0, room);
    dropped += Math.max(0, piece.length - room);
  };
  const finish = (): string => {
    let line = kept;
    let more = dropped;
    if (last === "\r") {
      if (more > 0) more--;
      else line = line.slice(0, -1);
    }
    kept = "";
    dropped = 0;
    last = "";
    return more > 0 ? `${line}... [line truncated, ${more} more chars]` : line;
  };
  for await (const chunk of createReadStream(path, signal ? { signal } : undefined)) {
    for (const [index, part] of decoder.decode(chunk, { stream: true }).split("\n").entries()) {
      signal?.throwIfAborted();
      if (index > 0) yield finish();
      add(part);
    }
  }
  signal?.throwIfAborted();
  add(decoder.decode());
  if (last !== "") yield finish();
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function audit(path: string, allowed: boolean, ctx: ToolContext): void {
  if (ctx.audit === false) return;
  try {
    const log = join(ctx.workspaceRoot ?? projectRoot(process.cwd()), AUDIT_LOG);
    mkdirSync(dirname(log), { recursive: true });
    appendFileSync(log, `${JSON.stringify({ path, allowed, timestamp: isoTimestamp() })}\n`);
  } catch (error) {
    console.error("omca: file_read audit entry not written:", error);
  }
}

function hasNullByte(file: string): boolean {
  const fd = openSync(file, "r");
  try {
    const sniff = Buffer.alloc(BINARY_SNIFF_BYTES);
    return sniff.subarray(0, readSync(fd, sniff, 0, sniff.length, 0)).includes(0);
  } finally {
    closeSync(fd);
  }
}

const expandHome = (path: string): string => expandTilde(PLATFORM, path, homedir()) ?? path;

// Windows names `file:stream` the stream of `file`, and drops trailing dots and spaces from a name.
const withoutWindowsAliases = (path: string): string => path.replace(/(?<=[^/:]):[^/]*$/, "").replace(/[. ]+$/, "");

export function isSensitivePath(platform: Platform, path: string): boolean {
  const posix = normalizePath(platform, path);
  const checked = platform === "win32" ? withoutWindowsAliases(posix) : posix;
  return SENSITIVE_PATH.test(checked);
}

// A UNC path, plain or in the long-path form, and macOS's automount root. Resolving one can contact
// the host it names, and on Windows send that host the user's credentials.
const UNC = /^[\\/]{2}(?:[?.][\\/]UNC[\\/]|[^\\/?.])/i;

export const isNetworkPath = (platform: Platform, path: string): boolean => UNC.test(path) || (platform === "darwin" && path.startsWith("/net/"));

/** The resolved file and its size, or the plain-text reason the read is refused. */
function inspect(path: string, unlimited: boolean): { file: string; size: number } | string {
  if (isNetworkPath(PLATFORM, path)) return `Access denied: ${path} is a network path, and looking it up can contact the host it names`;
  let file: string;
  try {
    file = realpathSync(resolve(expandHome(path)));
  } catch (error) {
    if (isMissing(error)) return `File not found: ${path}`;
    throw error;
  }
  const stat = statSync(file);
  if (stat.isDirectory()) return `Path is a directory, not a file: ${path}`;
  if (!stat.isFile()) return `Not a regular file (device/pipe/socket): ${path}`;
  if (isSensitivePath(PLATFORM, file)) return `Access denied: ${path} matches sensitive file pattern`;
  if (unlimited && stat.size > MAX_UNLIMITED_BYTES) {
    return `File too large for unlimited read: ${humanSize(stat.size)} (max ${humanSize(MAX_UNLIMITED_BYTES)}). Use offset and limit to read in chunks.`;
  }
  if (hasNullByte(file)) return `Binary file detected: ${path} (${humanSize(stat.size)})`;
  return { file, size: stat.size };
}

async function collectWindow(file: string, decoder: Decoder, offset: number, limit: number, signal?: AbortSignal) {
  const window: string[] = [];
  let total = 0;
  for await (const line of readLines(file, decoder, MAX_LINE_CHARS, signal)) {
    if (total >= offset && (limit <= 0 || window.length < limit)) window.push(line);
    total++;
  }
  return { window, total };
}

async function readWindow(file: string, encoding: string, offset: number, limit: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  try {
    const decoder = new TextDecoder(encoding, { fatal: true });
    return { ...(await collectWindow(file, decoder, offset, limit, signal)), usedEncoding: encoding };
  } catch (error) {
    // A TypeError is bytes invalid in the encoding and a RangeError is an unknown encoding name.
    signal?.throwIfAborted();
    if (!(error instanceof TypeError || error instanceof RangeError)) throw error;
  }
  return { ...(await collectWindow(file, LATIN1, offset, limit, signal)), usedEncoding: "latin-1" };
}

async function readChecked(path: string, encoding: string, offset: number, limit: number, signal?: AbortSignal) {
  const checked = inspect(path, limit <= 0);
  if (typeof checked === "string") return checked;
  return { size: checked.size, ...(await readWindow(checked.file, encoding, offset, limit, signal)) };
}

async function fileRead(args: Args, ctx = IDLE_CONTEXT): Promise<string> {
  ctx.signal.throwIfAborted();
  const path = ctx.workspaceRoot === undefined ? stringArg(args, "path") : resolve(ctx.workspaceRoot, stringArg(args, "path"));
  const offset = Math.max(0, integerArg(args, "offset", 0));
  const budgeted = args.limit === undefined || args.limit === null;
  const requested = integerArg(args, "limit", DEFAULT_LIMIT);
  const encoding = stringArg(args, "encoding", "utf-8");

  let read: Awaited<ReturnType<typeof readChecked>>;
  try {
    read = await readChecked(path, encoding, offset, requested, ctx.signal);
  } catch (error) {
    audit(path, false, ctx);
    throw error;
  }
  ctx.signal.throwIfAborted();
  audit(path, typeof read !== "string", ctx);
  if (typeof read === "string") return read;
  const { size, total, usedEncoding } = read;
  let { window } = read;
  if (total === 0) return "(empty file)";
  if (offset >= total) return `(offset ${offset} exceeds file length of ${total} lines)`;

  if (budgeted) {
    let used = 0;
    const fits = window.findIndex((line, index) => (used += line.length + 8) > DEFAULT_BUDGET_CHARS && index > 0);
    if (fits > 0) window = window.slice(0, fits);
  }
  const limit = budgeted ? window.length : requested;
  const footer = [`~${Math.floor(size / 4)} tokens (${humanSize(size)})`, `${total} lines total`];
  if (usedEncoding !== encoding) footer.push(`encoding fallback: ${usedEncoding}`);
  if (limit > 0 && offset + limit < total) {
    const next = offset + limit;
    footer.push(`${total - next} more lines available (use offset=${next} to continue)`);
  }
  const numbered = window.map((line, index) => `${String(offset + index + 1).padStart(6)}\t${line}`);
  return `${numbered.join("\n")}\n\n(${footer.join(", ")})`;
}

export const tools: Tool[] = [
  {
    name: "file_read",
    description:
      "Read a text file with line numbers, a size footer, and offset/limit paging. Use it for a path the built-in Read tool cannot reach, typically one outside the working directories while permissions.blockReadsOutsideWorkingDirectories is on; that setting fences Read, Grep, Glob, and LSP but not MCP tools. Without a limit it returns up to 1000 lines and stops at the last whole line under 40,000 characters, and the footer names the offset to continue from; lines over 2000 characters are cut with a truncation marker. The footer's token figure estimates the whole file (bytes / 4), not the returned window, and names the next offset when lines remain. Refuses with a plain-text message, not an error: directories, devices, binary files (a null byte in the first 8 KB), unlimited reads (limit=0) of files over 3 MB, paths matching a sensitive-file denylist (.ssh, .gnupg, .aws, .env files, credentials*, *secret*, SSH private keys, /etc/shadow), and network paths (UNC, or /net/ on macOS). Each call is logged to .omca/logs/file-access.jsonl.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file to read" },
        offset: {
          type: "integer",
          default: 0,
          description:
            "0-based line offset. Use with limit to paginate large files (e.g. offset=500, limit=200 reads lines 501-700)",
        },
        limit: {
          type: "integer",
          default: DEFAULT_LIMIT,
          description:
            "Max lines to return. Default 1000 lines or 40,000 characters, whichever comes first. Set to 0 for unlimited (blocked for >3MB files). Use smaller values for targeted reads to save tokens.",
        },
        encoding: {
          type: "string",
          default: "utf-8",
          description: "File encoding (default utf-8, falls back to latin-1)",
        },
      },
      required: ["path"],
    },
    annotations: { title: "Read a file", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    _meta: {
      "anthropic/searchHint": "read a file outside the project root, with line numbers and a token estimate",
      "anthropic/maxResultSizeChars": MAX_RESULT_CHARS,
    },
    call: fileRead,
  },
];
