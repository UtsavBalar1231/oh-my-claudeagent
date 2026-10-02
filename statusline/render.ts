import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveBoundPlan } from "../src/core/boulder.ts";
import { checkboxStates, nextTaskLabel } from "../src/core/checkboxes.ts";
import { baseName, inferPlatform } from "../src/core/path.ts";
import { cells, displayWidth, fitEnd } from "../src/core/ui-kit.ts";
import type { GitInfo } from "./git.ts";

export type Env = Record<string, string | undefined>;

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
  } | null;
  cwd?: string;
  context_window?: {
    context_window_size?: number | null;
    used_percentage?: number | null;
    remaining_percentage?: number | null;
    current_usage?: Usage | null;
  } | null;
  cost?: {
    total_cost_usd?: number | null;
    total_duration_ms?: number | null;
    total_lines_added?: number | null;
    total_lines_removed?: number | null;
  } | null;
  rate_limits?: { five_hour?: RateWindow | null; seven_day?: RateWindow | null } | null;
  exceeds_200k_tokens?: boolean | null;
  effort?: { level?: string } | null;
  session_id?: string | null;
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
// The plugin's settings.json starts every session on this agent, so naming it tells nothing.
export const DEFAULT_MAIN_AGENT = "oh-my-claudeagent:sisyphus";
const BLUE = "\x1b[34m";
const BOLD = "\x1b[1m";
export const SEP = ` ${DIM}·${RST} `;
const FILLED_BLOCK = "▰";
const EMPTY_BLOCK = "▱";
const ELLIPSIS = "…";
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const WARN_PERCENT = 60;
const CRIT_PERCENT = 85;
const RATE_LIMIT_BAR_WIDTH = 10;
// The context bar needs 8 blocks to keep the 60 and 85 percent thresholds visible (one block is 12.5 points)
// and stops at 20, where each block is 5 points and a wider bar adds no information.
const CONTEXT_BAR_MIN = 8;
const CONTEXT_BAR_MAX = 20;
// Claude Code keeps 2 cells of its own plus the 1 cell of `padding` that setup writes free on each side of the
// status line, and clips what runs into them (measured in a live session), so a line may use only what is left.
const STATUS_LINE_INSET = 6;
const COMPACT_BELOW_COLUMNS = 60;
const SHORT_TERMINAL_LINES = 20;
const SHORT_MAX_LINES = 2;
const MAX_LINES = 4;
// A next-task label cut to fewer cells than this is a fragment, so the plan segment wraps instead.
const MIN_LABEL_CELLS = 12;

export const NERD_GLYPHS = {
  branch: "",
  folder: "",
  model: "",
  clock: "",
  vim: "",
  worktree: "",
  fiveHour: "",
  weekly: "",
  tasks: "",
  effort: "",
};

type Glyphs = Record<keyof typeof NERD_GLYPHS, string>;

export const ASCII_GLYPHS: Glyphs = {
  branch: "*",
  folder: ">",
  model: ">",
  clock: "~",
  vim: "V:",
  worktree: "W:",
  fiveHour: "5h",
  weekly: "7d",
  tasks: "T:",
  effort: "E:",
};

export const AGENT_GLYPHS = new Map([
  ["explore", ""],
  ["hephaestus", ""],
  ["librarian", ""],
  ["metis", ""],
  ["momus", ""],
  ["multimodal-looker", ""],
  ["oracle", ""],
  ["prometheus", ""],
  ["sisyphus", ""],
  ["executor", ""],
]);
const DEFAULT_AGENT_GLYPH = "";

const PR_STATES = new Map([
  ["approved", { color: GREEN, nerd: "", ascii: "+" }],
  ["changes_requested", { color: RED, nerd: "", ascii: "!" }],
  ["pending", { color: YELLOW, nerd: "", ascii: "?" }],
  ["draft", { color: DIM, nerd: "", ascii: "d" }],
]);

interface Ctx {
  data: Payload;
  git: GitInfo;
  nerd: boolean;
  g: Glyphs;
  now: Date;
}

export function detectNerdFont(env: Env): boolean {
  const value = env["CLAUDE_STATUSLINE_NERD_FONT"];
  return value === undefined ? true : value.trim() === "1";
}

const positiveInt = (value: string | undefined): number | null => (/^\d+$/.test(value ?? "") && Number(value) > 0 ? Number(value) : null);

export function terminalColumns(env: Env): number {
  return positiveInt(env.COLUMNS) ?? 80;
}

export function terminalLines(env: Env): number | null {
  return positiveInt(env.LINES);
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
const ANSI_ALL = new RegExp(ANSI.source, "g");
const OSC8_CLOSERS = ["\x1b]8;;\x07", "\x1b]8;;\x1b\\"];

const textWidth = (s: string): number => displayWidth(s.replace(ANSI_ALL, ""));

const SEP_WIDTH = textWidth(SEP);

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

/** A piece of the status line that is drawn whole. `width` is in terminal cells, between `min` and `max`. */
export interface Segment {
  min: number;
  max: number;
  grows: boolean;
  draw(width: number): string;
}

export function block(text: string): Segment {
  const width = textWidth(text);
  return { min: width, max: width, grows: false, draw: () => text };
}

interface Placed {
  segment: Segment;
  width: number;
}

/**
 * Fills lines with segments in priority order. A segment that does not fit wraps whole to the next
 * line. When the lines run out, the segment and every lower one are dropped. A segment wider than
 * the terminal is skipped, except the first, which a final cut keeps within the width. A growing
 * segment is placed at its minimum, then takes the free cells left on its line up to its maximum.
 */
export function arrange(segments: readonly Segment[], columns: number, maxLines: number): string[] {
  let line: Placed[] = [];
  const lines = [line];
  let used = 0;
  for (const segment of segments) {
    const opening = lines.length === 1 && line.length === 0;
    if (segment.min > columns && !opening) continue;
    let placed = false;
    while (!placed) {
      const room = columns - used - (line.length > 0 ? SEP_WIDTH : 0);
      if (segment.min <= room || opening) {
        const width = segment.grows ? segment.min : Math.min(segment.max, Math.max(room, segment.min));
        used += (line.length > 0 ? SEP_WIDTH : 0) + width;
        line.push({ segment, width });
        placed = true;
      } else if (lines.length < maxLines) {
        line = [];
        lines.push(line);
        used = 0;
      } else {
        return lines.map((l) => drawLine(l, columns));
      }
    }
  }
  return lines.map((l) => drawLine(l, columns));
}

function drawLine(placed: readonly Placed[], columns: number): string {
  let spare = columns - placed.reduce((sum, { width }) => sum + width, 0) - SEP_WIDTH * (placed.length - 1);
  const pieces = placed.map(({ segment, width }) => {
    const grown = segment.grows ? Math.min(segment.max, width + Math.max(0, spare)) : width;
    spare -= grown - width;
    return segment.draw(grown);
  });
  return visibleTruncate(pieces.join(SEP), columns);
}

const arrow = (nerd: boolean): string => (nerd ? "→" : "->");

const osc8 = (url: string, text: string): string => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;

function remoteToUrl(remote: string): string {
  const url = remote.startsWith("git@") ? remote.replace(":", "/").replace("git@", "https://") : remote;
  return url.endsWith(".git") ? url.slice(0, -".git".length) : url;
}

const thresholdColor = (pct: number): string => (pct >= CRIT_PERCENT ? RED : pct >= WARN_PERCENT ? YELLOW : GREEN);

export function renderBar(pct: number, width: number, color: string): string {
  const filled = Number(fixed((Math.max(0, Math.min(100, pct)) / 100) * width, 0));
  return `${color}${FILLED_BLOCK}${RST}`.repeat(filled) + `${DIM}${EMPTY_BLOCK}${RST}`.repeat(width - filled);
}

function contextPercent({ context_window: ctx }: Payload): number | null {
  if (ctx == null) return null;
  const size = ctx.context_window_size ?? 200000;
  const pct = ctx.used_percentage ?? (ctx.remaining_percentage != null ? 100 - ctx.remaining_percentage : null);
  if (pct !== null) return Math.max(0, Math.min(100, pct));
  const usage = ctx.current_usage;
  if (usage == null || size <= 0) return null;
  const used = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  return Math.max(0, Math.min(100, (used / size) * 100));
}

const sizeLabel = ({ context_window: ctx }: Payload): string => ((ctx?.context_window_size ?? 200000) >= 1000000 ? "1M" : "200k");

function contextSegment(data: Payload): Segment {
  const pct = contextPercent(data);
  const size = `${DIM}${sizeLabel(data)}${RST}`;
  const color = thresholdColor(pct ?? 0);
  const warn = data.exceeds_200k_tokens && (data.context_window?.context_window_size ?? 200000) <= 200000 ? ` ${RED}${BOLD}!${RST}` : "";
  const tail = pct === null ? ` ${DIM}[waiting...]${RST}  ${size}` : ` ${color}${fixed(pct, 0)}%${RST}${warn}  ${size}`;
  const tailWidth = textWidth(tail);
  return {
    min: CONTEXT_BAR_MIN + tailWidth,
    max: CONTEXT_BAR_MAX + tailWidth,
    grows: true,
    draw: (width) => {
      const barWidth = width - tailWidth;
      return `${pct === null ? `${DIM}${EMPTY_BLOCK.repeat(barWidth)}${RST}` : renderBar(pct, barWidth, color)}${tail}`;
    },
  };
}

const percentSegment = (data: Payload): Segment | null => {
  const pct = contextPercent(data);
  return pct === null ? null : block(`${thresholdColor(pct)}${fixed(pct, 0)}%${RST}`);
};

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

export function composePr(data: Payload, nerd: boolean): string {
  const pr = data.pr;
  if (pr?.number == null) return "";
  const number = `${pr.kind === "mr" ? "!" : "#"}${pr.number}`;
  const state = PR_STATES.get(pr.review_state ?? "");
  const stateSuffix = state ? ` ${state.color}${nerd ? state.nerd : state.ascii}${RST}` : "";
  return `${CYAN}${pr.url ? osc8(pr.url, number) : number}${RST}${stateSuffix}`;
}

export interface PlanProgress {
  done: number;
  total: number;
  label: string | null;
}

export function readPlan(projectDir: string, sessionId: string): PlanProgress | null {
  try {
    const boulder = JSON.parse(readFileSync(join(projectDir, ".omca", "state", "boulder.json"), "utf8"));
    const planPath = resolveBoundPlan(boulder, sessionId, true).active_plan;
    if (!planPath) return null;
    const plan = readFileSync(planPath, "utf8");
    const states = checkboxStates(plan);
    const done = states.filter((state) => state === "x").length;
    if (states.length === 0 || done === states.length) return null;
    return { done, total: states.length, label: nextTaskLabel(plan) || null };
  } catch {
    return null;
  }
}

function planSegment({ done, total, label }: PlanProgress, { nerd, g }: Ctx): Segment {
  const count = `${GREEN}${g.tasks} ${done}/${total}${RST}`;
  if (label === null) return block(count);
  const head = `${count} ${DIM}${arrow(nerd)} `;
  const headWidth = textWidth(head);
  const labelWidth = displayWidth(label);
  return {
    min: headWidth + Math.min(labelWidth, MIN_LABEL_CELLS),
    max: headWidth + labelWidth,
    grows: false,
    draw: (width) => `${head}${fitEnd(label, width - headWidth, ELLIPSIS)}${RST}`,
  };
}

export function agentGlyph(name: string, nerd: boolean): string {
  if (!nerd) return "A:";
  return AGENT_GLYPHS.get(name.replace(/^oh-my-claudeagent:/, "")) ?? DEFAULT_AGENT_GLYPH;
}

const modelName = ({ data }: Ctx): string => data.model?.display_name ?? "Claude";

function branchOf({ data, git }: Ctx): string {
  return data.worktree?.branch || (git.repo ? git.branch : "");
}

function branchSegment(c: Ctx): Segment | null {
  const branch = branchOf(c);
  if (!branch) return null;
  const { git, g } = c;
  const counts = [
    git.modified > 0 ? `${YELLOW}~${git.modified}${RST}` : "",
    git.staged > 0 ? `${GREEN}+${git.staged}${RST}` : "",
    git.untracked > 0 ? `${DIM}?${git.untracked}${RST}` : "",
  ].filter(Boolean);
  return block(`${WHITE}${g.branch} ${branch}${RST}${counts.length > 0 ? ` ${counts.join("  ")}` : ""}`);
}

function directorySegment({ data, git, g }: Ctx): Segment | null {
  const projectDir = projectDirOf(data);
  const name = baseName(inferPlatform(projectDir), projectDir);
  if (!name) return null;
  const remoteUrl = remoteToUrl(git.remote);
  return block(`${DIM}${g.folder} ${remoteUrl ? osc8(remoteUrl, name) : name}${RST}`);
}

function rateLimitSegments({ data, g, now }: Ctx): Segment[] {
  const windows = [
    { window: data.rate_limits?.five_hour, glyph: g.fiveHour },
    { window: data.rate_limits?.seven_day, glyph: g.weekly },
  ];
  return windows.flatMap(({ window, glyph }) => {
    const pct = window?.used_percentage;
    if (pct == null) return [];
    const color = thresholdColor(pct);
    const reset = formatResetTime(window?.resets_at, now);
    return [block(`${renderBar(pct, RATE_LIMIT_BAR_WIDTH, color)} ${color}${fixed(pct, 0)}%${RST} ${DIM}${glyph}${RST}${reset ? ` (resets ${reset})` : ""}`)];
  });
}

const present = (segments: readonly (Segment | null)[]): Segment[] => segments.filter((s) => s !== null);

function fullSegments(c: Ctx): Segment[] {
  const { data, nerd, g } = c;
  const effort = `${data.effort?.level ?? ""}`.trim();
  const projectDir = projectDirOf(data);
  const plan = projectDir ? readPlan(projectDir, data.session_id ?? "") : null;
  const worktree = data.worktree;
  const pr = composePr(data, nerd);
  const cost = data.cost;
  const added = cost?.total_lines_added ?? 0;
  const removed = cost?.total_lines_removed ?? 0;
  const changed = [added > 0 ? `${GREEN}+${added}${RST}` : "", removed > 0 ? `${RED}-${removed}${RST}` : ""].filter(Boolean);
  const addedDirs = data.workspace?.added_dirs?.length ?? 0;
  return present([
    block(`${CYAN}${g.model} ${modelName(c)}${RST}${effort ? `${SEP}${YELLOW}${g.effort} ${effort}${RST}` : ""}`),
    data.vim?.mode ? block(`${YELLOW}${g.vim} ${data.vim.mode[0]}${RST}`) : null,
    plan ? planSegment(plan, c) : null,
    contextSegment(data),
    branchSegment(c),
    directorySegment(c),
    data.agent?.name && data.agent.name !== DEFAULT_MAIN_AGENT ? block(`${MAGENTA}${agentGlyph(data.agent.name, nerd)} ${data.agent.name}${RST}`) : null,
    worktree?.name ? block(`${BLUE}${g.worktree} ${worktree.name}${RST}${worktree.original_branch ? ` ${DIM}<- ${worktree.original_branch}${RST}` : ""}`) : null,
    pr ? block(pr) : null,
    block(`${MAGENTA}$${cost?.total_cost_usd != null ? fixed(cost.total_cost_usd, 2) : "0.00"}${RST}${SEP}${BLUE}${g.clock} ${formatDuration(cost?.total_duration_ms)}${RST}`),
    ...rateLimitSegments(c),
    changed.length > 0 ? block(changed.join("/")) : null,
    addedDirs > 0 ? block(`${DIM}+${addedDirs} dir${addedDirs === 1 ? "" : "s"}${RST}`) : null,
  ]);
}

function compactSegments(c: Ctx): Segment[] {
  const { data } = c;
  const projectDir = projectDirOf(data);
  const plan = projectDir ? readPlan(projectDir, data.session_id ?? "") : null;
  const branch = branchOf(c);
  return present([
    block(`${CYAN}${c.g.model} ${modelName(c)}${RST}`),
    plan ? block(`${GREEN}${c.g.tasks} ${plan.done}/${plan.total}${RST}`) : null,
    percentSegment(data),
    branch ? block(`${WHITE}${c.g.branch} ${branch}${RST}`) : null,
  ]);
}

export function render(data: Payload, git: GitInfo, env: Env, now: Date): string {
  const nerd = detectNerdFont(env);
  const c: Ctx = { data, git, nerd, g: nerd ? NERD_GLYPHS : ASCII_GLYPHS, now };
  const columns = terminalColumns(env);
  const width = Math.max(1, columns - STATUS_LINE_INSET);
  if (columns < COMPACT_BELOW_COLUMNS) return arrange(compactSegments(c), width, 1).join("\n");
  const rows = terminalLines(env);
  return arrange(fullSegments(c), width, rows !== null && rows < SHORT_TERMINAL_LINES ? SHORT_MAX_LINES : MAX_LINES).join("\n");
}
