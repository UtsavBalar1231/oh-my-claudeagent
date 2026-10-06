import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveBoundPlan } from "../src/core/boulder.ts";
import { checkboxStates, nextTaskLabel } from "../src/core/checkboxes.ts";
import { baseName, inferPlatform } from "../src/core/path.ts";
import { AGENT_ICONS, cells, displayWidth, fitEnd, formatDuration, type GlyphTier, glyphTier } from "../src/core/ui-kit.ts";
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

interface SpendLimit extends RateWindow {
  used_usd?: number | null;
  limit_usd?: number | null;
  period?: string | null;
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
  rate_limits?: { five_hour?: RateWindow | null; seven_day?: RateWindow | null; spend_limit?: SpendLimit | null } | null;
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
export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const BLUE = "\x1b[34m";
export const BOLD = "\x1b[1m";
export const separator = (dot: string): string => ` ${DIM}${dot}${RST} `;
const SEP = separator("·");
// The plugin's settings.json starts every session on this agent, so naming it tells nothing.
export const DEFAULT_MAIN_AGENT = "oh-my-claudeagent:orchestrator";
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
  filled: "▰",
  empty: "▱",
  dot: "·",
  ellipsis: "…",
  arrow: "→",
  branch: "",
  folder: "",
  model: "",
  clock: "",
  vim: "",
  worktree: "",
  fiveHour: "",
  weekly: "",
  spend: "",
  tasks: "",
  effort: "",
};

export type Glyphs = Record<keyof typeof NERD_GLYPHS, string>;

// The Unicode tier is the line without Nerd Font icons; the ASCII tier also trades its bars, dots and ellipsis.
export const UNICODE_GLYPHS: Glyphs = {
  filled: "▰",
  empty: "▱",
  dot: "·",
  ellipsis: "…",
  arrow: "->",
  branch: "*",
  folder: ">",
  model: ">",
  clock: "~",
  vim: "V:",
  worktree: "W:",
  fiveHour: "5h",
  weekly: "7d",
  spend: "S:",
  tasks: "T:",
  effort: "E:",
};

export const ASCII_GLYPHS: Glyphs = {
  filled: "#",
  empty: ".",
  dot: "|",
  ellipsis: "...",
  arrow: "->",
  branch: "*",
  folder: ">",
  model: ">",
  clock: "~",
  vim: "V:",
  worktree: "W:",
  fiveHour: "5h",
  weekly: "7d",
  spend: "S:",
  tasks: "T:",
  effort: "E:",
};

const DEFAULT_AGENT_GLYPH = "\u{f007}";

const PR_STATES = new Map([
  ["approved", { color: GREEN, nerd: "", ascii: "+" }],
  ["changes_requested", { color: RED, nerd: "", ascii: "!" }],
  ["pending", { color: YELLOW, nerd: "", ascii: "?" }],
  ["draft", { color: DIM, nerd: "", ascii: "d" }],
]);

interface Ctx {
  data: Payload;
  git: GitInfo;
  tier: GlyphTier;
  g: Glyphs;
  now: Date;
}

/** The glyph set `OMCA_GLYPHS` names, the same variable the mod reads; Nerd Font glyphs when it is unset. */
export function statusGlyphs(env: Env): { tier: GlyphTier; g: Glyphs } {
  const tier = glyphTier(env["OMCA_GLYPHS"]);
  return { tier, g: tier === "nerd" ? NERD_GLYPHS : tier === "unicode" ? UNICODE_GLYPHS : ASCII_GLYPHS };
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

// Every tier's separator is one cell between two spaces.
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
export function arrange(segments: readonly Segment[], columns: number, maxLines: number, sep = SEP): string[] {
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
        return lines.map((l) => drawLine(l, columns, sep));
      }
    }
  }
  return lines.map((l) => drawLine(l, columns, sep));
}

function drawLine(placed: readonly Placed[], columns: number, sep: string): string {
  let spare = columns - placed.reduce((sum, { width }) => sum + width, 0) - SEP_WIDTH * (placed.length - 1);
  const pieces = placed.map(({ segment, width }) => {
    const grown = segment.grows ? Math.min(segment.max, width + Math.max(0, spare)) : width;
    spare -= grown - width;
    return segment.draw(grown);
  });
  return visibleTruncate(pieces.join(sep), columns);
}

const osc8 = (url: string, text: string): string => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;

function remoteToUrl(remote: string): string {
  const url = remote.startsWith("git@") ? remote.replace(":", "/").replace("git@", "https://") : remote;
  return url.endsWith(".git") ? url.slice(0, -".git".length) : url;
}

const thresholdColor = (pct: number): string => (pct >= CRIT_PERCENT ? RED : pct >= WARN_PERCENT ? YELLOW : GREEN);

export function renderBar(pct: number, width: number, color: string, g: Pick<Glyphs, "filled" | "empty"> = NERD_GLYPHS): string {
  const filled = Number(fixed((Math.max(0, Math.min(100, pct)) / 100) * width, 0));
  return `${color}${g.filled}${RST}`.repeat(filled) + `${DIM}${g.empty}${RST}`.repeat(width - filled);
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

function contextSegment(data: Payload, g: Glyphs): Segment {
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
      return `${pct === null ? `${DIM}${g.empty.repeat(barWidth)}${RST}` : renderBar(pct, barWidth, color, g)}${tail}`;
    },
  };
}

const percentSegment = (data: Payload): Segment | null => {
  const pct = contextPercent(data);
  return pct === null ? null : block(`${thresholdColor(pct)}${fixed(pct, 0)}%${RST}`);
};

export function formatResetTime(resetsAt: number | null | undefined, now: Date): string {
  if (typeof resetsAt !== "number") return "";
  const reset = new Date(resetsAt * 1000);
  if (Number.isNaN(reset.getTime())) return "";
  const hour = reset.getHours();
  const time = `${hour % 12 || 12}${hour < 12 ? "am" : "pm"}`;
  return reset.toDateString() === now.toDateString() ? time : `${DAYS[reset.getDay()]} ${time}`;
}

export function composePr(data: Payload, tier: GlyphTier): string {
  const pr = data.pr;
  if (pr?.number == null) return "";
  const number = `${pr.kind === "mr" ? "!" : "#"}${pr.number}`;
  const state = PR_STATES.get(pr.review_state ?? "");
  const stateSuffix = state ? ` ${state.color}${tier === "nerd" ? state.nerd : state.ascii}${RST}` : "";
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
    const planPath = resolveBoundPlan(boulder, sessionId, true)?.active_plan;
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

function planSegment({ done, total, label }: PlanProgress, { g }: Ctx): Segment {
  const count = `${GREEN}${g.tasks} ${done}/${total}${RST}`;
  if (label === null) return block(count);
  const head = `${count} ${DIM}${g.arrow} `;
  const headWidth = textWidth(head);
  const labelWidth = displayWidth(label);
  return {
    min: headWidth + Math.min(labelWidth, MIN_LABEL_CELLS),
    max: headWidth + labelWidth,
    grows: false,
    draw: (width) => `${head}${fitEnd(label, width - headWidth, g.ellipsis)}${RST}`,
  };
}

export function agentGlyph(name: string, tier: GlyphTier): string {
  if (tier !== "nerd") return "A:";
  const short = name.replace(/^oh-my-claudeagent:/, "");
  return (Object.hasOwn(AGENT_ICONS, short) ? AGENT_ICONS[short] : undefined) ?? DEFAULT_AGENT_GLYPH;
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
  return block(`${g.branch} ${branch}${counts.length > 0 ? ` ${counts.join("  ")}` : ""}`);
}

function directorySegment({ data, git, g }: Ctx): Segment | null {
  const projectDir = projectDirOf(data);
  const name = baseName(inferPlatform(projectDir), projectDir);
  if (!name) return null;
  const remoteUrl = remoteToUrl(git.remote);
  return block(`${DIM}${g.folder} ${remoteUrl ? osc8(remoteUrl, name) : name}${RST}`);
}

function rateLimitSegment({ data, g, now }: Ctx, which: "five_hour" | "seven_day"): Segment | null {
  const window = data.rate_limits?.[which];
  const pct = window?.used_percentage;
  if (pct == null) return null;
  const color = thresholdColor(pct);
  const reset = formatResetTime(window?.resets_at, now);
  const glyph = which === "five_hour" ? g.fiveHour : g.weekly;
  return block(`${renderBar(pct, RATE_LIMIT_BAR_WIDTH, color, g)} ${color}${fixed(pct, 0)}%${RST} ${DIM}${glyph}${RST}${reset ? ` (resets ${reset})` : ""}`);
}

const SPEND_PERIODS = new Map([
  ["daily", "day"],
  ["weekly", "wk"],
  ["monthly", "mo"],
]);

function spendSegment({ data, g }: Ctx): Segment | null {
  const spend = data.rate_limits?.spend_limit;
  const used = spend?.used_usd;
  const limit = spend?.limit_usd;
  if (used == null || limit == null) return null;
  const pct = spend?.used_percentage ?? (limit > 0 ? (used / limit) * 100 : 0);
  const period = SPEND_PERIODS.get(spend?.period ?? "");
  const cap = Number.isInteger(limit) ? String(limit) : fixed(limit, 2);
  return block(`${thresholdColor(pct)}${g.spend} $${fixed(used, 2)}/$${cap}${RST}${period ? ` ${DIM}${period}${RST}` : ""}`);
}

const present = (segments: readonly (Segment | null)[]): Segment[] => segments.filter((s) => s !== null);

const isSubscription = ({ rate_limits: limits }: Payload): boolean => limits?.five_hour != null || limits?.seven_day != null;

function costSegment({ data, g }: Ctx): Segment {
  const usd = data.cost?.total_cost_usd ?? 0;
  const cost = !isSubscription(data) && usd > 0 ? `${MAGENTA}$${fixed(usd, 2)}${RST}${separator(g.dot)}` : "";
  return block(`${cost}${BLUE}${g.clock} ${formatDuration(data.cost?.total_duration_ms ?? 0)}${RST}`);
}

/** The full view's rows, session, workspace and usage, each its segments in priority order. */
export interface Ranked {
  segment: Segment;
  rank: number;
}

// The order segments give way in when the rows run past the line budget, across rows, so a narrow
// terminal keeps its time and 5 hour limit before the workspace row's lines-changed tail.
const RANK = {
  model: 0,
  plan: 1,
  context: 2,
  branch: 3,
  cost: 4,
  fiveHour: 5,
  directory: 6,
  agent: 7,
  vim: 8,
  worktree: 9,
  pr: 10,
  sevenDay: 11,
  spend: 12,
  changed: 13,
  dirs: 14,
} as const;

const ranked = (rank: number, segment: Segment | null): Ranked[] => (segment === null ? [] : [{ segment, rank }]);

function fullRows(c: Ctx): Ranked[][] {
  const { data, tier, g } = c;
  const effort = `${data.effort?.level ?? ""}`.trim();
  const projectDir = projectDirOf(data);
  const plan = projectDir ? readPlan(projectDir, data.session_id ?? "") : null;
  const worktree = data.worktree;
  const pr = composePr(data, tier);
  const added = data.cost?.total_lines_added ?? 0;
  const removed = data.cost?.total_lines_removed ?? 0;
  const changed = [added > 0 ? `${GREEN}+${added}${RST}` : "", removed > 0 ? `${RED}-${removed}${RST}` : ""].filter(Boolean);
  const addedDirs = data.workspace?.added_dirs?.length ?? 0;
  return [
    [
      ...ranked(RANK.model, block(`${CYAN}${g.model} ${modelName(c)}${RST}${effort ? `${separator(g.dot)}${YELLOW}${g.effort} ${effort}${RST}` : ""}`)),
      ...ranked(RANK.vim, data.vim?.mode ? block(`${YELLOW}${g.vim} ${data.vim.mode[0]}${RST}`) : null),
      ...ranked(RANK.agent, data.agent?.name && data.agent.name !== DEFAULT_MAIN_AGENT ? block(`${MAGENTA}${agentGlyph(data.agent.name, tier)} ${data.agent.name}${RST}`) : null),
      ...ranked(RANK.plan, plan ? planSegment(plan, c) : null),
    ],
    [
      ...ranked(RANK.context, contextSegment(data, g)),
      ...ranked(RANK.branch, branchSegment(c)),
      ...ranked(RANK.directory, directorySegment(c)),
      ...ranked(RANK.worktree, worktree?.name ? block(`${BLUE}${g.worktree} ${worktree.name}${RST}${worktree.original_branch ? ` ${DIM}<- ${worktree.original_branch}${RST}` : ""}`) : null),
      ...ranked(RANK.pr, pr ? block(pr) : null),
      ...ranked(RANK.changed, changed.length > 0 ? block(changed.join("/")) : null),
      ...ranked(RANK.dirs, addedDirs > 0 ? block(`${DIM}+${addedDirs} dir${addedDirs === 1 ? "" : "s"}${RST}`) : null),
    ],
    [
      ...ranked(RANK.cost, costSegment(c)),
      ...ranked(RANK.fiveHour, rateLimitSegment(c, "five_hour")),
      ...ranked(RANK.sevenDay, rateLimitSegment(c, "seven_day")),
      ...ranked(RANK.spend, spendSegment(c)),
    ],
  ];
}

/**
 * Starts each row on its own line and wraps a row within itself. While the lines run past
 * `maxLines`, the segment with the highest rank in any row is dropped; rank 0 always stays.
 */
export function stackRows(rows: readonly (readonly Ranked[])[], columns: number, maxLines: number, sep = SEP): string[] {
  const kept = rows.map((row) => [...row]);
  for (;;) {
    const lines = kept.flatMap((row) => (row.length > 0 ? arrange(row.map(({ segment }) => segment), columns, maxLines, sep) : []));
    if (lines.length <= maxLines) return lines;
    let worst: { row: number; index: number; rank: number } | undefined;
    kept.forEach((row, rowIndex) =>
      row.forEach(({ rank }, index) => {
        if (rank > 0 && (worst === undefined || rank > worst.rank)) worst = { row: rowIndex, index, rank };
      }),
    );
    if (worst === undefined) return lines;
    kept[worst.row]?.splice(worst.index, 1);
  }
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
    branch ? block(`${c.g.branch} ${branch}`) : null,
  ]);
}

export function render(data: Payload, git: GitInfo, env: Env, now: Date): string {
  const c: Ctx = { data, git, ...statusGlyphs(env), now };
  const sep = separator(c.g.dot);
  const columns = terminalColumns(env);
  const width = Math.max(1, columns - STATUS_LINE_INSET);
  if (columns < COMPACT_BELOW_COLUMNS) return arrange(compactSegments(c), width, 1, sep).join("\n");
  const rows = terminalLines(env);
  return stackRows(fullRows(c), width, rows !== null && rows < SHORT_TERMINAL_LINES ? SHORT_MAX_LINES : MAX_LINES, sep).join("\n");
}
