import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../src/core/frontmatter.ts";
import { formatTokens, shortType } from "../src/core/ui-kit.ts";
import {
  agentGlyph,
  arrange,
  block,
  BOLD,
  DIM,
  fixed,
  type Glyphs,
  GREEN,
  RED,
  RST,
  separator,
  statusGlyphs,
  terminalColumns,
  YELLOW,
} from "./render.ts";
import type { GlyphTier } from "../src/core/ui-kit.ts";

interface Task {
  id?: string;
  name?: string;
  type?: string;
  agentType?: string;
  label?: string;
  status?: string;
  model?: string;
  effort?: string | number | boolean | null;
  tokenCount?: number;
  contextWindowSize?: number;
}

const OMCA_PREFIX = "oh-my-claudeagent:";
const MODEL_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;
const TIER_ALIASES = new Set(["opus", "sonnet", "fable", "haiku"]);
const STATUS_COLORS = new Map([
  ["in_progress", YELLOW],
  ["running", YELLOW],
  ["pending", DIM],
  ["completed", GREEN],
  ["success", GREEN],
  ["failed", RED],
  ["error", RED],
]);

const capitalize = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

function friendlyModel(model: string): string {
  if (TIER_ALIASES.has(model)) return capitalize(model);
  const [, family, major, minor] = MODEL_ID.exec(model) ?? [];
  if (family === undefined || major === undefined) return model;
  return `${capitalize(family)} ${minor === undefined ? major : `${major}.${minor}`}`;
}

function frontmatterModel(name: string): string {
  if (!name.startsWith(OMCA_PREFIX)) return "";
  try {
    const model = parseFrontmatter(readFileSync(join(import.meta.dir, "..", "agents", `${name.slice(OMCA_PREFIX.length)}.md`), "utf8"))?.["model"];
    return typeof model === "string" ? model : "";
  } catch {
    return "";
  }
}

function effortLabel(effort: Task["effort"]): string {
  if (typeof effort === "number" && Number.isInteger(effort)) return formatTokens(effort);
  return typeof effort === "string" ? effort.trim() : "";
}

// The subagent type names the row: `name` is only the name a subagent is addressed by, and the
// task's label follows last, so a long one gives way first on a narrow row.
function row(task: Task, { tier, g }: { tier: GlyphTier; g: Glyphs }, columns: number): string {
  const identity = task.agentType || task.name;
  const name = identity ? shortType(identity) : task.label || task.type || "agent";
  const parts = [`${BOLD}${agentGlyph(name, tier)} ${name}${RST}`];

  const model = friendlyModel(task.model || frontmatterModel(identity ?? ""));
  if (model) parts.push(`${DIM}${g.model} ${model}${RST}`);

  if (task.status) parts.push(`${STATUS_COLORS.get(task.status) ?? DIM}${task.status}${RST}`);

  const effort = effortLabel(task.effort);
  if (effort) parts.push(`${YELLOW}${g.effort} ${effort}${RST}`);

  const tokens = task.tokenCount;
  if (typeof tokens === "number" && Number.isInteger(tokens) && tokens > 0) {
    const window = task.contextWindowSize;
    parts.push(
      typeof window === "number" && Number.isInteger(window) && window > 0
        ? `${DIM}${fixed(Math.min(100, (tokens / window) * 100), 0)}% ctx${RST}`
        : `${DIM}${formatTokens(tokens)} tok${RST}`,
    );
  }
  if (identity && task.label) parts.push(`${DIM}${task.label}${RST}`);
  return arrange(parts.map(block), columns, 1, separator(g.dot)).join("");
}

try {
  const raw = await Bun.stdin.text();
  const dump = process.env["OMCA_SUBAGENT_STATUSLINE_DUMP"];
  if (dump) {
    try {
      appendFileSync(dump, `${raw.trimEnd()}\n`);
    } catch {}
  }
  const data: { tasks?: unknown; columns?: unknown } | null = JSON.parse(raw);
  const columns = typeof data?.columns === "number" && data.columns > 0 ? data.columns : terminalColumns(process.env);
  const look = statusGlyphs(process.env);
  const tasks: (Task | null)[] = Array.isArray(data?.tasks) ? data.tasks : [];
  const rows = tasks.flatMap((task) => (task?.id ? [`${JSON.stringify({ id: task.id, content: row(task, look, columns) })}\n`] : []));
  process.stdout.write(rows.join(""));
} catch {}
