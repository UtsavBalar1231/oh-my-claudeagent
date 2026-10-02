import { createReadStream, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { projectRoot } from "../io.ts";
import { isObject } from "../jsonrpc.ts";
import type { Tool } from "../omca.ts";
import { IDLE_CONTEXT } from "../progress.ts";
import { integerArg, isMissing, readLines, stringArg } from "./filesystem.ts";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const EXCERPT_RADIUS = 100;
const ROLES = ["user", "assistant", "tool"];
// At most 50 excerpts of about 200 characters plus JSON overhead, far under the client's 500,000 ceiling.
const MAX_RESULT_CHARS = 100_000;
// The client replaces a spilled tool result inline with a pointer to the sidecar plus a prefix of
// its body, so the same text lives in two places.
// The client names the path after "saved to: ", and it may hold spaces; any other mention must be one token.
const SPILL_TAIL = String.raw`[\\/]tool-results[\\/][^\s\\/]+\.txt`;
const SPILL_POINTER = new RegExp(String.raw`saved to: ([^\r\n]*?${SPILL_TAIL})|((?:[A-Za-z]:[\\/]|\\\\|/)\S+${SPILL_TAIL})`);

type Match = { file: string; timestamp: string; role: string; excerpt: string };
type Source = { path: string; label: string; mtimeMs: number; sidecar: boolean };

const transcriptsRoot = (): string =>
  process.env.OMCA_TRANSCRIPTS_ROOT || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");

const excerptAround = (text: string, index: number, length: number): string =>
  text.slice(Math.max(0, index - EXCERPT_RADIUS), Math.min(text.length, index + length + EXCERPT_RADIUS));

function namesIn(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function listSources(dir: string, includeSidecars: boolean): Source[] {
  const names = namesIn(dir);
  const source = (path: string, label: string, sidecar: boolean): Source => ({
    path,
    label,
    sidecar,
    mtimeMs: statSync(path).mtimeMs,
  });
  const transcripts = names.filter((name) => name.endsWith(".jsonl")).map((name) => source(join(dir, name), name, false));
  const sidecars = includeSidecars
    ? names.flatMap((session) =>
        namesIn(join(dir, session, "tool-results"))
          .filter((name) => name.endsWith(".txt"))
          .map((name) => source(join(dir, session, "tool-results", name), `${session}/tool-results/${name}`, true)),
      )
    : [];
  return [...transcripts, ...sidecars].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** (role, text) pairs of one message. Text blocks keep the message's role; tool use and results are role "tool". */
function textsOf(type: string, content: unknown): Array<[string, string]> {
  if (typeof content === "string") return content === "" ? [] : [[type, content]];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block): Array<[string, string]> => {
    if (!isObject(block)) return [];
    if (block.type === "text") return typeof block.text === "string" && block.text !== "" ? [[type, block.text]] : [];
    if (block.type === "tool_use") return [["tool", JSON.stringify(block.input ?? {})]];
    if (block.type !== "tool_result") return [];
    if (typeof block.content === "string") return [["tool", block.content]];
    if (!Array.isArray(block.content)) return [];
    return block.content.flatMap((part): Array<[string, string]> =>
      isObject(part) && part.type === "text" ? [["tool", typeof part.text === "string" ? part.text : ""]] : [],
    );
  });
}

export function spillPointer(text: string): string | undefined {
  const found = SPILL_POINTER.exec(text);
  return found?.[1] ?? found?.[2];
}

function isSpilledCopy(text: string, spilled: ReadonlySet<string>): boolean {
  const pointer = spillPointer(text);
  return pointer !== undefined && existsSync(pointer) && spilled.has(realpathSync(pointer));
}

/** Matches of one transcript, newest turn first. Only the newest `keep` are retained while streaming. */
async function searchTranscript(
  source: Source,
  query: string,
  role: string,
  spilled: ReadonlySet<string>,
  keep: number,
  signal: AbortSignal,
): Promise<Match[]> {
  const found: Match[] = [];
  for await (const line of readLines(source.path, new TextDecoder())) {
    signal.throwIfAborted();
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(record) || (record.type !== "user" && record.type !== "assistant") || !isObject(record.message)) continue;
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : "";
    const turn: Match[] = [];
    for (const [textRole, text] of textsOf(record.type, record.message.content)) {
      if (role !== "" && textRole !== role) continue;
      if (textRole === "tool" && isSpilledCopy(text, spilled)) continue;
      const index = text.toLowerCase().indexOf(query);
      if (index !== -1) turn.push({ file: source.label, timestamp, role: textRole, excerpt: excerptAround(text, index, query.length) });
    }
    found.push(...turn.reverse());
    if (found.length > keep) found.splice(0, found.length - keep);
  }
  return found.reverse();
}

/** The first hit in a spilled tool result as a one-element list, or none. Reads one chunk at a time. */
async function searchSidecar(source: Source, query: string, signal: AbortSignal): Promise<Match[]> {
  const decoder = new TextDecoder();
  // Between chunks only the left context and a hit straddling the chunk boundary must survive.
  const keepTail = EXCERPT_RADIUS + query.length - 1;
  const toMatch = (text: string, hit: number): Match[] => [
    {
      file: source.label,
      timestamp: new Date(source.mtimeMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
      role: "tool",
      excerpt: excerptAround(text, hit, query.length),
    },
  ];
  let text = "";
  for await (const chunk of createReadStream(source.path)) {
    signal.throwIfAborted();
    text += decoder.decode(chunk, { stream: true });
    const hit = text.toLowerCase().indexOf(query);
    if (hit === -1) text = text.slice(-keepTail);
    else if (text.length >= hit + query.length + EXCERPT_RADIUS) return toMatch(text, hit);
  }
  text += decoder.decode();
  const hit = text.toLowerCase().indexOf(query);
  return hit === -1 ? [] : toMatch(text, hit);
}

async function sessionSearch(args: Record<string, unknown>, { signal, progress } = IDLE_CONTEXT): Promise<string> {
  const query = stringArg(args, "query");
  const root = projectRoot(stringArg(args, "project_path", "") || process.cwd());
  const requestedRole = stringArg(args, "role", "");
  const role = ROLES.includes(requestedRole) ? requestedRole : "";
  const limit = Math.max(1, Math.min(integerArg(args, "limit", DEFAULT_LIMIT), MAX_LIMIT));
  const slug = root.replace(/[^A-Za-z0-9]/g, "-");
  const dir = join(transcriptsRoot(), slug);
  const base = { query, project_path: root, slug };
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    const note = `no transcript directory found at ${dir}`;
    return JSON.stringify({ ...base, matches: [], truncated: false, note }, null, 2);
  }

  const sources = listSources(dir, role === "" || role === "tool");
  const spilled = new Set(sources.filter((source) => source.sidecar).map((source) => realpathSync(source.path)));
  const queryLower = query.toLowerCase();
  const matches: Match[] = [];
  let truncated = false;
  for (const [index, source] of sources.entries()) {
    signal.throwIfAborted();
    progress({ message: `Searching ${source.label}, ${index + 1} of ${sources.length}`, progress: index, total: sources.length });
    const found = source.sidecar
      ? await searchSidecar(source, queryLower, signal)
      : await searchTranscript(source, queryLower, role, spilled, limit + 1, signal);
    const room = limit - matches.length;
    matches.push(...found.slice(0, room));
    if (found.length > room) {
      truncated = true;
      break;
    }
  }
  const note = truncated ? { note: `[TRUNCATED] returned ${matches.length} of possibly more matches; raise limit (max 50) to see more` } : {};
  return JSON.stringify({ ...base, matches, truncated, ...note }, null, 2);
}

export const tools: Tool[] = [
  {
    name: "session_search",
    description:
      "Search local Claude Code session transcripts for a project. Read-only; scans only the resolved project's own transcript directory under the client's projects directory (~/.claude/projects/<slug>/ by default), never other projects. Matches are case-insensitive substrings (no regex) over user/assistant/tool turn text, extracted from the JSONL block structure so hits land in readable text rather than raw JSON. Returns bounded, capped-excerpt matches (~200 chars around each hit), newest turns first, with a truncation note when more matches exist than were returned. Malformed transcript lines are skipped silently. Large tool results that the client spilled to <session>/tool-results/*.txt are scanned as well and reported with role \"tool\", ordered by file mtime since they carry no timestamp; the truncated inline copy of a scanned sidecar is not reported a second time; subagent transcripts under <session>/subagents/ are not scanned. Privacy: reads local conversation history; excerpts may contain prior session content.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Case-insensitive substring to search for. No regex support." },
        project_path: { type: "string", default: "", description: "Project root (default: cwd's git root)" },
        role: {
          type: "string",
          default: "",
          description: "Filter to one role: user, assistant, or tool. Empty = all roles.",
        },
        limit: {
          type: "integer",
          default: DEFAULT_LIMIT,
          description: "Max matches to return (default 10, hard max 50).",
        },
      },
      required: ["query"],
    },
    annotations: { title: "Search session transcripts", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    _meta: {
      "anthropic/searchHint": "search this project's past Claude Code session transcripts",
      "anthropic/maxResultSizeChars": MAX_RESULT_CHARS,
    },
    call: sessionSearch,
  },
];
