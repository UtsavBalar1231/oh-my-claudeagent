import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveBoundPlan } from "../src/core/boulder.ts";
import { checkboxStates, nextTaskLabel } from "../src/core/checkboxes.ts";
import { baseName, inferPlatform } from "../src/core/path.ts";
import { cells } from "../src/core/ui-kit.ts";
import { type Config, type Env, readConfig } from "./config.ts";
import type { GitInfo } from "./git.ts";

interface Usage {
  input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

interface RateWindow {
  used_percentage?: number | null;
  resets_at?: number | null;
}

export interface Payload {
  model?: { display_name?: string } | null;
  workspace?: {
    project_dir?: string;
    added_dirs?: string[] | null;
    repo?: { host?: string; owner?: string; name?: string } | null;
  } | null;
  cwd?: string;
  context_window?: {
    context_window_size?: number | null;
    used_percentage?: number | null;
    remaining_percentage?: number | null;
    current_usage?: Usage | null;
    total_input_tokens?: number | null;
    total_output_tokens?: number | null;
  } | null;
  cost?: {
    total_cost_usd?: number | null;
    total_duration_ms?: number | null;
    total_api_duration_ms?: number | null;
    total_lines_added?: number | null;
    total_lines_removed?: number | null;
  } | null;
  rate_limits?: { five_hour?: RateWindow | null; seven_day?: RateWindow | null } | null;
  exceeds_200k_tokens?: boolean | null;
  effort?: { level?: string } | null;
  thinking?: { enabled?: boolean } | null;
  session_id?: string | null;
  session_name?: string | null;
  transcript_path?: string | null;
  version?: string | null;
  output_style?: { name?: string } | null;
  agent?: { name?: string } | null;
  worktree?: { name?: string; branch?: string; original_branch?: string } | null;
  vim?: { mode?: string } | null;
  pr?: { number?: number | null; url?: string; review_state?: string; kind?: string } | null;
}

export const FALLBACK = "[claude]";

export const RST = "\x1b[0m";
export const DIM = "\x1b[90m";
const CYAN = "\x1b[36m";
export const WHITE = "\x1b[37m";
export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const BLUE = "\x1b[34m";
const BOLD = "\x1b[1m";
export const SEP = ` ${DIM}·${RST} `;
const FILLED_BLOCK = "▰";
const EMPTY_BLOCK = "▱";
const RATE_LIMIT_BAR_WIDTH = 10;
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export const NERD_GLYPHS = {
  branch: "\ue725",
  folder: "\uf07c",
  model: "\uf135",
  clock: "\uf017",
  vim: "\ue7c5",
  worktree: "\ue728",
  style: "\uf10c",
  warn: "\uf071",
  fiveHour: "\uf251",
  weekly: "\uf073",
  tasks: "\uf0ae",
  effort: "\uf0e7",
  thinking: "\uf0eb",
};

type Glyphs = Record<keyof typeof NERD_GLYPHS, string>;

export const ASCII_GLYPHS: Glyphs = {
  branch: "*",
  folder: ">",
  model: ">",
  clock: "~",
  vim: "V:",
  worktree: "W:",
  style: "S:",
  warn: "!",
  fiveHour: "5h",
  weekly: "7d",
  tasks: "T:",
  effort: "E:",
  thinking: "[T]",
};

export const AGENT_GLYPHS = new Map([
  ["explore", "\uf14e"],
  ["hephaestus", "\uf0ad"],
  ["librarian", "\uf02d"],
  ["metis", "\uf002"],
  ["momus", "\uf075"],
  ["multimodal-looker", "\uf030"],
  ["oracle", "\uf06e"],
  ["prometheus", "\uf06d"],
  ["sisyphus", "\uef08"],
  ["executor", "\uf085"],
]);
const DEFAULT_AGENT_GLYPH = "\uf007";

const PR_STATES = new Map([
  ["approved", { color: GREEN, nerd: "\uf00c", ascii: "+" }],
  ["changes_requested", { color: RED, nerd: "\uf00d", ascii: "!" }],
  ["pending", { color: YELLOW, nerd: "\uf017", ascii: "?" }],
  ["draft", { color: DIM, nerd: "\uf040", ascii: "d" }],
]);

interface Ctx {
  data: Payload;
  git: GitInfo;
  nerd: boolean;
  g: Glyphs;
  config: Config;
  now: Date;
}

export function detectNerdFont(env: Env): boolean {
  for (const name of ["CLAUDE_STATUSLINE_NERD_FONT", "NERD_FONT"]) {
    const value = env[name];
    if (value !== undefined) return value.trim() === "1";
  }
  return true;
}

export function terminalColumns(env: Env): number {
  const columns = /^\d+$/.test(env.COLUMNS ?? "") ? Number(env.COLUMNS) : 0;
  return columns > 0 ? columns : 80;
}

export function projectDirOf(data: Payload): string {
  return data.workspace?.project_dir ?? data.cwd ?? "";
}

// Round half to even: an exact binary tie goes to the even neighbour, where toFixed and Math.round go up.
export function fixed(x: number, digits: number): string {
  const exact = x.toFixed(digits + 25);
  if (!/^50*$/.test(exact.slice(exact.length - 25))) return x.toFixed(digits);
  const down = Math.floor(x * 10 ** digits);
  return ((down % 2 === 0 ? down : down + 1) / 10 ** digits).toFixed(digits);
}

const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/y;
const OSC8_CLOSERS = ["\x1b]8;;\x07", "\x1b]8;;\x1b\\"];

// Counts terminal cells, a wide code point as two. Escape sequences occupy none and are never cut in half; a link still open at the cut is closed.
export function visibleTruncate(s: string, width: number): string {
  if (width <= 0) return "";
  let out = "";
  let visible = 0;
  let linkOpen = false;
  for (let i = 0; i < s.length; ) {
    ANSI.lastIndex = i;
    const escape = ANSI.exec(s)?.[0];
    if (escape !== undefined) {
      if (escape.startsWith("\x1b]8;;")) linkOpen = !OSC8_CLOSERS.includes(escape);
      out += escape;
      i += escape.length;
      continue;
    }
    const codePoint = s.codePointAt(i) ?? 0;
    const room = cells(codePoint);
    if (visible + room > width) break;
    const char = String.fromCodePoint(codePoint);
    out += char;
    visible += room;
    i += char.length;
  }
  return `${out}${linkOpen ? OSC8_CLOSERS[0] : ""}${RST}`;
}

const arrow = (nerd: boolean): string => (nerd ? "\u2192" : "->");

const fileUrl = (path: string): string => pathToFileURL(path, { windows: inferPlatform(path) === "win32" }).href;

const osc8 = (url: string, text: string): string => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;

function remoteToUrl(remote: string): string {
  const url = remote.startsWith("git@") ? remote.replace(":", "/").replace("git@", "https://") : remote;
  return url.endsWith(".git") ? url.slice(0, -".git".length) : url;
}

function thresholdColor(pct: number, { warnPercent, critPercent }: Config): string {
  return pct >= critPercent ? RED : pct >= warnPercent ? YELLOW : GREEN;
}

export function renderBar(pct: number, width: number, color: string): string {
  const filled = Number(fixed((Math.max(0, Math.min(100, pct)) / 100) * width, 0));
  return `${color}${FILLED_BLOCK}${RST}`.repeat(filled) + `${DIM}${EMPTY_BLOCK}${RST}`.repeat(width - filled);
}

function contextBar({ data, config }: Ctx): string {
  const ctx = data.context_window ?? {};
  const size = ctx.context_window_size ?? 200000;
  const sizeLabel = size >= 1000000 ? "1M" : "200k";
  let pct = ctx.used_percentage ?? (ctx.remaining_percentage != null ? 100 - ctx.remaining_percentage : null);
  if (pct === null) {
    const usage = ctx.current_usage;
    if (usage == null || size <= 0) {
      return `${DIM}${EMPTY_BLOCK.repeat(config.barWidth)}${RST} ${DIM}[waiting...]${RST}  ${DIM}${sizeLabel}${RST}`;
    }
    pct = (((usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)) / size) * 100;
  }
  pct = Math.max(0, Math.min(100, pct));
  const color = thresholdColor(pct, config);
  const warn = data.exceeds_200k_tokens && size <= 200000 ? ` ${RED}${BOLD}!${RST}` : "";
  return `${renderBar(pct, config.barWidth, color)} ${color}${fixed(pct, 0)}%${RST}${warn}  ${DIM}${sizeLabel}${RST}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${fixed(n / 1_000_000, 1)}M`;
  if (n >= 1_000) return `${fixed(n / 1_000, 1)}k`;
  return String(n);
}

function formatDuration(ms: number | null | undefined): string {
  const totalSeconds = Math.floor((ms ?? 0) / 1000);
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

export function formatResetTime(resetsAt: number | null | undefined, now: Date): string {
  if (typeof resetsAt !== "number") return "";
  const reset = new Date(resetsAt * 1000);
  if (Number.isNaN(reset.getTime())) return "";
  const hour = reset.getHours();
  const time = `${hour % 12 || 12}${hour < 12 ? "am" : "pm"}`;
  return reset.toDateString() === now.toDateString() ? time : `${DAYS[reset.getDay()]} ${time}`;
}

export function composeRepoPr(data: Payload, nerd: boolean): string {
  const repo = data.workspace?.repo;
  if (!repo?.name) return "";
  const label = repo.owner ? `${repo.owner}/${repo.name}` : repo.name;
  const display = repo.host && repo.owner ? osc8(`https://${repo.host}/${repo.owner}/${repo.name}`, label) : label;
  const segment = `${DIM}${display}${RST}`;
  const pr = data.pr;
  if (pr?.number == null) return segment;
  const number = `${pr.kind === "mr" ? "!" : "#"}${pr.number}`;
  const state = PR_STATES.get(pr.review_state ?? "");
  const stateSuffix = state ? ` ${state.color}${nerd ? state.nerd : state.ascii}${RST}` : "";
  return `${segment} ${CYAN}${pr.url ? osc8(pr.url, number) : number}${RST}${stateSuffix}`;
}

export function todoCounter(projectDir: string, sessionId: string, nerd: boolean): string {
  try {
    const boulder = JSON.parse(readFileSync(join(projectDir, ".omca", "state", "boulder.json"), "utf8"));
    const planPath = resolveBoundPlan(boulder, sessionId, true).active_plan;
    if (!planPath) return "";
    const plan = readFileSync(planPath, "utf8");
    const states = checkboxStates(plan);
    const done = states.filter((state) => state === "x").length;
    if (states.length === 0 || done === states.length) return "";
    const label = nextTaskLabel(plan);
    return `${GREEN}${(nerd ? NERD_GLYPHS : ASCII_GLYPHS).tasks} ${done}/${states.length}${RST}${label ? ` ${DIM}${arrow(nerd)} ${label}${RST}` : ""}`;
  } catch {
    return "";
  }
}

export function agentGlyph(name: string, nerd: boolean): string {
  if (!nerd) return "A:";
  return AGENT_GLYPHS.get(name.replace(/^oh-my-claudeagent:/, "")) ?? DEFAULT_AGENT_GLYPH;
}

const isOmcaDefault = (style: string): boolean => style.slice(style.indexOf(":") + 1).trim() === "OMCA Default";

const modelSegment = ({ data, g }: Ctx): string => `${CYAN}${g.model} ${data.model?.display_name ?? "Claude"}${RST}`;

function infoLine(c: Ctx): { line: string; extra: boolean } {
  const { data, git, nerd, g } = c;
  const parts = [modelSegment(c)];
  let extra = false;

  const effort = `${data.effort?.level ?? ""}`.trim();
  if (effort) {
    parts.push(`${YELLOW}${g.effort} ${effort}${RST}`);
    extra = true;
  }
  if (data.thinking?.enabled) {
    parts.push(`${CYAN}${g.thinking}${RST}`);
    extra = true;
  }

  const projectDir = projectDirOf(data);
  if (projectDir) {
    const todo = todoCounter(projectDir, data.session_id ?? "", nerd);
    if (todo) {
      parts.push(todo);
      extra = true;
    }
  }

  const sessionLabel = data.session_name ?? (data.session_id != null ? data.session_id.slice(0, 8) : null);
  if (sessionLabel !== null) {
    parts.push(`${DIM}${data.transcript_path ? osc8(fileUrl(data.transcript_path), sessionLabel) : sessionLabel}${RST}`);
  }

  const branch = data.worktree?.branch || (git.repo ? git.branch : "");
  if (branch) {
    extra = true;
    parts.push(`${WHITE}${g.branch} ${branch}${RST}`);
    const counts = [
      git.modified > 0 ? `${YELLOW}~${git.modified}${RST}` : "",
      git.staged > 0 ? `${GREEN}+${git.staged}${RST}` : "",
      git.untracked > 0 ? `${DIM}?${git.untracked}${RST}` : "",
    ].filter(Boolean);
    if (counts.length > 0) parts.push(counts.join("  "));
  }

  const dirName = baseName(inferPlatform(projectDir), projectDir);
  if (dirName) {
    const remoteUrl = remoteToUrl(git.remote);
    parts.push(`${DIM}${g.folder} ${remoteUrl ? osc8(remoteUrl, dirName) : dirName}${RST}`);
  }

  const addedDirs = data.workspace?.added_dirs?.length ?? 0;
  if (addedDirs > 0) {
    extra = true;
    parts.push(`${DIM}+${addedDirs} dir${addedDirs === 1 ? "" : "s"}${RST}`);
  }

  const repoPr = composeRepoPr(data, nerd);
  if (repoPr) {
    extra = true;
    parts.push(repoPr);
  }

  if (data.agent != null) {
    extra = true;
    if (data.agent.name) parts.push(`${MAGENTA}${agentGlyph(data.agent.name, nerd)} ${data.agent.name}${RST}`);
  }

  if (data.worktree != null) {
    extra = true;
    const { name, original_branch: original } = data.worktree;
    if (name) parts.push(`${BLUE}${g.worktree} ${name}${RST}${original ? ` ${DIM}<- ${original}${RST}` : ""}`);
  }

  const style = data.output_style?.name ?? "default";
  if (style && style !== "default") {
    extra = true;
    parts.push(isOmcaDefault(style) ? `${DIM}${g.style} OMCA Default${RST}` : `${RED}${g.warn} DEGRADED: ${style}${RST}`);
  }

  if (data.vim != null) {
    extra = true;
    if (data.vim.mode) parts.push(`${YELLOW}${g.vim} ${data.vim.mode[0]}${RST}`);
  }

  if (data.version != null) parts.push(`${DIM}v${data.version}${RST}`);
  return { line: parts.join(SEP), extra };
}

const costSegment = ({ data }: Ctx): string => `${MAGENTA}$${data.cost?.total_cost_usd != null ? fixed(data.cost.total_cost_usd, 2) : "0.00"}${RST}`;

const clockSegment = ({ data, g }: Ctx): string => `${BLUE}${g.clock} ${formatDuration(data.cost?.total_duration_ms)}${RST}`;

function metricsLine(c: Ctx): string {
  const { data } = c;
  const parts = [contextBar(c), costSegment(c), clockSegment(c)];
  const added = data.cost?.total_lines_added ?? 0;
  const removed = data.cost?.total_lines_removed ?? 0;
  const changed = [added > 0 ? `${GREEN}+${added}${RST}` : "", removed > 0 ? `${RED}-${removed}${RST}` : ""].filter(Boolean);
  if (changed.length > 0) parts.push(changed.join("/"));
  const tokens = (data.context_window?.total_input_tokens ?? 0) + (data.context_window?.total_output_tokens ?? 0);
  if (tokens > 0) parts.push(`${DIM}${formatTokens(tokens)} tok${RST}`);
  const apiMs = data.cost?.total_api_duration_ms;
  if (apiMs != null) parts.push(`${DIM}api ${Math.floor(apiMs / 1000)}s${RST}`);
  return parts.join(SEP);
}

function rateLimitLine({ data, g, config, now }: Ctx): string | null {
  const windows = [
    { window: data.rate_limits?.five_hour, glyph: g.fiveHour },
    { window: data.rate_limits?.seven_day, glyph: g.weekly },
  ];
  const parts: string[] = [];
  for (const { window, glyph } of windows) {
    const pct = window?.used_percentage;
    if (pct == null) continue;
    const color = thresholdColor(pct, config);
    const reset = formatResetTime(window?.resets_at, now);
    parts.push(`${renderBar(pct, RATE_LIMIT_BAR_WIDTH, color)} ${color}${fixed(pct, 0)}%${RST} ${DIM}${glyph} ${RST}${reset ? `(resets ${reset})` : ""}`);
  }
  return parts.length > 0 ? parts.join(SEP) : null;
}

function degradedTip({ data, nerd }: Ctx): string | null {
  const style = data.output_style?.name ?? "default";
  if (!style || style === "default" || isOmcaDefault(style)) return null;
  const pointer = arrow(nerd);
  return `${DIM}${pointer} run ${RST}${YELLOW}/oh-my-claudeagent:omca-setup${RST}${DIM} to diagnose / clear pin ${pointer} restart Claude Code to load OMCA Default${RST}`;
}

export function render(data: Payload, git: GitInfo, env: Env, now: Date): string {
  const nerd = detectNerdFont(env);
  const c: Ctx = { data, git, nerd, g: nerd ? NERD_GLYPHS : ASCII_GLYPHS, config: readConfig(env), now };
  const columns = terminalColumns(env);
  const { line, extra } = infoLine(c);
  const lines = git.repo || extra
    ? [line, metricsLine(c), rateLimitLine(c), degradedTip(c)].filter((l) => l !== null)
    : [[modelSegment(c), contextBar(c), costSegment(c), clockSegment(c)].join(SEP)];
  return lines.map((l) => visibleTruncate(l, columns)).join("\n");
}
