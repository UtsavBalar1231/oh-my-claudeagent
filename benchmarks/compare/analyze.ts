export const CATEGORIES = [
  "system_prompt",
  "tools_builtin",
  "tools_mcp",
  "deferred_listing",
  "environment",
  "agent_listing",
  "skill_listing",
  "output_style",
  "mcp_instructions",
  "hook_context",
  "context_reminder",
  "attribution",
  "conversation",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];
export type Breakdown = { chars: Record<Category, number>; prompt_chars: number; tools_builtin_n: number; tools_mcp_n: number; mcp_servers: Record<string, number> };

const CHARS_PER_TOKEN = 4;
export const tokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const MARKERS: { label: Category; pattern: RegExp }[] = [
  { label: "environment", pattern: /(?:^|\n)# Environment\n/g },
  { label: "deferred_listing", pattern: /(?:^|\n)The following deferred tools are now available via ToolSearch/g },
  { label: "agent_listing", pattern: /(?:^|\n)Available agent types for the Agent tool:/g },
  { label: "skill_listing", pattern: /(?:^|\n)The following skills are available for use with the Skill tool:/g },
  { label: "output_style", pattern: /(?:^|\n)# Output Style:/g },
  { label: "mcp_instructions", pattern: /(?:^|\n)# MCP Server Instructions/g },
  { label: "hook_context", pattern: /(?:^|\n)[A-Za-z]+(?::[\w.-]+)? hook (?:additional context|success):/g },
];

function classifyText(text: string): [Category, number][] {
  const hits = MARKERS.flatMap(({ label, pattern }) => [...text.matchAll(pattern)].map((m) => ({ label, at: m.index ?? 0 })));
  hits.sort((x, y) => x.at - y.at);
  const head: Category = text.startsWith("<system-reminder>\nAs you answer")
    ? "context_reminder"
    : text.startsWith("<system-reminder>\nAttribution")
      ? "attribution"
      : "other";
  const first = hits[0];
  const regions: [Category, number][] = [[head, first === undefined ? text.length : first.at]];
  hits.forEach((hit, i) => regions.push([hit.label, (hits[i + 1]?.at ?? text.length) - hit.at]));
  return regions;
}

function blockText(block: unknown): { text: string; conversation: boolean } {
  if (!isRecord(block)) return { text: "", conversation: false };
  if (block.type === "text" && typeof block.text === "string") return { text: block.text, conversation: false };
  if (block.type === "tool_use") return { text: `${String(block.name)}${JSON.stringify(block.input)}`, conversation: true };
  if (block.type === "tool_result") {
    const content = block.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (isRecord(c) && typeof c.text === "string" ? c.text : "")).join("") : "";
    return { text, conversation: true };
  }
  return { text: JSON.stringify(block), conversation: true };
}

export function breakdown(body: Record<string, unknown>): Breakdown {
  const chars = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  const system = body.system;
  if (typeof system === "string") chars.system_prompt = system.length;
  else if (Array.isArray(system)) chars.system_prompt = system.reduce((n: number, b) => n + (isRecord(b) && typeof b.text === "string" ? b.text.length : 0), 0);

  const servers: Record<string, number> = {};
  let builtinN = 0;
  let mcpN = 0;
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    const size = JSON.stringify(tool).length;
    const name = isRecord(tool) && typeof tool.name === "string" ? tool.name : "";
    if (name.startsWith("mcp__")) {
      chars.tools_mcp += size;
      mcpN++;
      const server = name.split("__")[1] ?? "?";
      servers[server] = (servers[server] ?? 0) + 1;
    } else {
      chars.tools_builtin += size;
      builtinN++;
    }
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  let promptChars = 0;
  const firstUser = messages.find((m) => isRecord(m) && m.role === "user");
  const promptBlock = isRecord(firstUser) && Array.isArray(firstUser.content)
    ? firstUser.content.findLast((b) => isRecord(b) && b.type === "text" && typeof b.text === "string" && !b.text.startsWith("<system-reminder>"))
    : undefined;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (block === promptBlock) {
        promptChars += blockText(block).text.length;
        continue;
      }
      const { text, conversation } = blockText(block);
      if (conversation) chars.conversation += text.length;
      else for (const [label, size] of classifyText(text)) chars[label] += size;
    }
  }
  return { chars, prompt_chars: promptChars, tools_builtin_n: builtinN, tools_mcp_n: mcpN, mcp_servers: servers };
}

export const totalChars = (b: Breakdown): number => CATEGORIES.reduce((n, c) => n + b.chars[c], 0);

export type Stats = { n: number; median: number; p25: number; p75: number; p95: number; min: number; max: number };

function quantile(sorted: number[], q: number): number {
  const rank = (sorted.length - 1) * q;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (rank - lo);
}

export function stats(xs: number[]): Stats | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: s.length,
    median: quantile(s, 0.5),
    p25: quantile(s, 0.25),
    p75: quantile(s, 0.75),
    p95: s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] as number,
    min: s[0] as number,
    max: s[s.length - 1] as number,
  };
}

export const median = (xs: number[]): number | null => stats(xs)?.median ?? null;

export function pairedDiffs(arm: (number | null)[], base: (number | null)[]): number[] {
  const out: number[] = [];
  arm.forEach((v, i) => {
    const b = base[i];
    if (v !== null && b !== null && b !== undefined) out.push(v - b);
  });
  return out;
}

const ESCAPES: Record<string, number> = { n: 10, t: 9, r: 13, v: 11, f: 12, a: 7, b: 8, "\\": 92, '"': 34 };

export function unescapeStrace(literal: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < literal.length; i++) {
    const ch = literal[i] as string;
    if (ch !== "\\") {
      bytes.push(ch.charCodeAt(0));
      continue;
    }
    const next = literal[i + 1] as string;
    const octal = /^[0-7]{1,3}/.exec(literal.slice(i + 1, i + 4));
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += octal[0].length;
    } else if (ESCAPES[next] !== undefined) {
      bytes.push(ESCAPES[next]);
      i += 1;
    } else if (next === "x") {
      bytes.push(Number.parseInt(literal.slice(i + 2, i + 4), 16));
      i += 3;
    }
  }
  return bytes;
}

export function dnsName(bytes: number[]): string | null {
  const labels: string[] = [];
  let at = 12;
  while (at < bytes.length) {
    const len = bytes[at] as number;
    if (len === 0) return labels.length > 0 ? labels.join(".") : null;
    if (len > 63 || at + len >= bytes.length) return null;
    labels.push(String.fromCharCode(...bytes.slice(at + 1, at + 1 + len)));
    at += len + 1;
  }
  return null;
}

export type NetworkAttempts = { hosts: string[]; connects: string[] };

export function parseConnectTrace(text: string, ignoreAddresses: string[]): NetworkAttempts {
  const hosts = new Set<string>();
  const connects = new Set<string>();
  for (const line of text.split("\n")) {
    const dns = /(?:sendto\(\d+, |iov_base=)"((?:[^"\\]|\\.)*)"/.exec(line);
    if (dns !== null) {
      const bytes = unescapeStrace(dns[1] as string);
      const isQuery = bytes[2] === 1 && bytes[4] === 0 && bytes[5] === 1;
      const name = isQuery ? dnsName(bytes) : null;
      if (name !== null) hosts.add(name);
      continue;
    }
    const conn = /connect\(\d+, \{sa_family=AF_INET6?, sin6?_port=htons\((\d+)\), (?:sin_addr=inet_addr\("([^"]+)"\)|sin6_addr=inet_pton\(AF_INET6, "([^"]+)"\))/.exec(line);
    if (conn !== null) {
      const address = (conn[2] ?? conn[3]) as string;
      const target = `${address}:${conn[1]}`;
      if (!ignoreAddresses.includes(address) && !address.startsWith("127.") && address !== "::1" && conn[1] !== "53") connects.add(target);
    }
  }
  return { hosts: [...hosts].sort(), connects: [...connects].sort() };
}

export type ExecCount = { total: number; byExe: Record<string, number> };

export function parseExecveTrace(text: string): ExecCount {
  const byExe: Record<string, number> = {};
  let total = 0;
  for (const line of text.split("\n")) {
    const m = /execve\("([^"]+)"/.exec(line);
    if (m === null || /= -1 /.test(line)) continue;
    total++;
    const exe = (m[1] as string).split("/").at(-1) as string;
    byExe[exe] = (byExe[exe] ?? 0) + 1;
  }
  return { total, byExe };
}

export type SnapEntry = { type: string; size: number; sum: string };

export function parseSnapshot(text: string): Map<string, SnapEntry> {
  const out = new Map<string, SnapEntry>();
  for (const line of text.split("\n")) {
    const [type, size, sum, ...rest] = line.split("\t");
    if (type === undefined || rest.length === 0) continue;
    out.set(rest.join("\t"), { type, size: Number(size), sum: sum ?? "-" });
  }
  return out;
}

export type SnapDiff = { created: string[]; modified: string[]; deleted: string[] };

export function diffSnapshots(before: Map<string, SnapEntry>, after: Map<string, SnapEntry>): SnapDiff {
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [path, entry] of after) {
    const old = before.get(path);
    if (old === undefined) created.push(path);
    else if (entry.type === "f" && (old.size !== entry.size || old.sum !== entry.sum)) modified.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) deleted.push(path);
  return { created, modified, deleted };
}

const UNIT = 1024;

export function humanBytes(n: number): string {
  if (n < UNIT) return `${n} B`;
  if (n < UNIT * UNIT) return `${(n / UNIT).toFixed(1)} KiB`;
  return `${(n / UNIT / UNIT).toFixed(1)} MiB`;
}

export function blockedBy(text: string): string {
  const plugin = /denied by plugin ([\w.-]+)/.exec(text);
  if (plugin !== null) return `plugin ${plugin[1]}`;
  if (/Dangerous rm operation detected/.test(text)) return "Claude Code built-in check";
  const hook = /^(\w+:\w+) hook error/.exec(text.trimStart());
  if (hook !== null) return `${hook[1]} hook script`;
  return text === "" ? "" : "unattributed";
}
