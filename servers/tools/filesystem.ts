import { appendFileSync, closeSync, createReadStream, mkdirSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Tool } from "../omca.ts";

const DEFAULT_LIMIT = 5000;
const MAX_UNLIMITED_BYTES = 3 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;
// A minified bundle is one line; without a cap a single line can outweigh the whole read.
const MAX_LINE_CHARS = 2000;
// The default window at the line cap can reach 10M characters in theory. 200,000 covers a normal
// source file whole, so ordinary reads are not spilled to disk, and stays under the client's ceiling.
const MAX_RESULT_CHARS = 200_000;
const AUDIT_LOG = join(".omca", "logs", "file-access.jsonl");
const SENSITIVE_PATH = /\/\.(?:ssh|gnupg|aws)\/|\/\.env(?:$|\.)|\/(?:credentials|id_rsa|id_ed25519)|secret|^\/etc\/g?shadow$/;

type Args = Record<string, unknown>;
type Decoder = { decode(chunk?: Buffer, options?: { stream: boolean }): string };

const LATIN1: Decoder = { decode: (chunk) => chunk?.toString("latin1") ?? "" };

export function stringArg(args: Args, name: string, fallback?: string): string {
  const value = args[name] ?? fallback;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

export function integerArg(args: Args, name: string, fallback: number): number {
  const value = args[name] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

export const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");

/** Yields the lines of a file without holding more than one decoded chunk and the unfinished line. */
export async function* readLines(path: string, decoder: Decoder): AsyncGenerator<string> {
  const withoutCr = (line: string) => (line.endsWith("\r") ? line.slice(0, -1) : line);
  let pending = "";
  for await (const chunk of createReadStream(path)) {
    const lines = (pending + decoder.decode(chunk, { stream: true })).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) yield withoutCr(line);
  }
  pending += decoder.decode();
  if (pending !== "") yield withoutCr(pending);
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

function audit(path: string, allowed: boolean): void {
  try {
    const log = join(process.cwd(), AUDIT_LOG);
    mkdirSync(dirname(log), { recursive: true });
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    appendFileSync(log, `${JSON.stringify({ path, allowed, timestamp })}\n`);
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

const expandHome = (path: string): string => (path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path);

/** The resolved file and its size, or the plain-text reason the read is refused. */
function inspect(path: string, unlimited: boolean): { file: string; size: number } | string {
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
  if (SENSITIVE_PATH.test(file)) return `Access denied: ${path} matches sensitive file pattern`;
  if (unlimited && stat.size > MAX_UNLIMITED_BYTES) {
    return `File too large for unlimited read: ${humanSize(stat.size)} (max ${humanSize(MAX_UNLIMITED_BYTES)}). Use offset and limit to read in chunks.`;
  }
  if (hasNullByte(file)) return `Binary file detected: ${path} (${humanSize(stat.size)})`;
  return { file, size: stat.size };
}

async function collectWindow(file: string, decoder: Decoder, offset: number, limit: number) {
  const window: string[] = [];
  let total = 0;
  for await (const line of readLines(file, decoder)) {
    if (total >= offset && (limit <= 0 || window.length < limit)) {
      const dropped = line.length - MAX_LINE_CHARS;
      window.push(dropped > 0 ? `${line.slice(0, MAX_LINE_CHARS)}... [line truncated, ${dropped} more chars]` : line);
    }
    total++;
  }
  return { window, total };
}

async function readWindow(file: string, encoding: string, offset: number, limit: number) {
  try {
    const decoder = new TextDecoder(encoding, { fatal: true });
    return { ...(await collectWindow(file, decoder, offset, limit)), usedEncoding: encoding };
  } catch (error) {
    // A TypeError is bytes invalid in the encoding and a RangeError is an unknown encoding name.
    if (!(error instanceof TypeError || error instanceof RangeError)) throw error;
  }
  return { ...(await collectWindow(file, LATIN1, offset, limit)), usedEncoding: "latin-1" };
}

async function fileRead(args: Args): Promise<string> {
  const path = stringArg(args, "path");
  const offset = Math.max(0, integerArg(args, "offset", 0));
  const limit = integerArg(args, "limit", DEFAULT_LIMIT);
  const encoding = stringArg(args, "encoding", "utf-8");

  const checked = inspect(path, limit <= 0);
  if (typeof checked === "string") {
    audit(path, false);
    return checked;
  }
  const { window, total, usedEncoding } = await readWindow(checked.file, encoding, offset, limit);
  audit(path, true);
  if (total === 0) return "(empty file)";
  if (offset >= total) return `(offset ${offset} exceeds file length of ${total} lines)`;

  const footer = [`~${Math.floor(checked.size / 4)} tokens (${humanSize(checked.size)})`, `${total} lines total`];
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
      "Read a text file with line numbers, a size footer, and offset/limit paging. Use it for a path the built-in Read tool cannot reach, typically one outside the working directories while permissions.blockReadsOutsideWorkingDirectories is on; that setting fences Read, Grep, Glob, and LSP but not MCP tools. Default limit is 5000 lines; lines over 2000 characters are cut with a truncation marker. The footer's token figure estimates the whole file (bytes / 4), not the returned window, and names the next offset when lines remain. Refuses with a plain-text message, not an error: directories, devices, binary files (a null byte in the first 8 KB), unlimited reads (limit=0) of files over 3 MB, and paths matching a sensitive-file denylist (.ssh, .gnupg, .aws, .env files, credentials*, *secret*, SSH private keys, /etc/shadow). Each call is logged to .omca/logs/file-access.jsonl.",
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
            "Max lines to return. Default 5000. Set to 0 for unlimited (blocked for >3MB files). Use smaller values for targeted reads to save tokens.",
        },
        encoding: {
          type: "string",
          default: "utf-8",
          description: "File encoding (default utf-8, falls back to latin-1)",
        },
      },
      required: ["path"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    _meta: {
      "anthropic/searchHint": "read a file outside the project root, with line numbers and a token estimate",
      "anthropic/maxResultSizeChars": MAX_RESULT_CHARS,
    },
    call: fileRead,
  },
];
