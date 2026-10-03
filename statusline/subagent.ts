import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../src/core/frontmatter.ts";
import {
  agentGlyph,
  arrange,
  ASCII_GLYPHS,
  block,
  BOLD,
  detectNerdFont,
  DIM,
  fixed,
  formatTokens,
  GREEN,
  NERD_GLYPHS,
  RED,
  RST,
  terminalColumns,
  YELLOW,
} from "./render.ts";

interface Task {
  id?: string;
  name?: string;
  type?: string;
  label?: string;
  status?: string;
  model?: string;
  effort?: string | number | boolean | null;
  tokenCount?: number;
  contextWindowSize?: number;
}

const OMCA_PREFIX = "oh-my-claudeagent:";
const MODEL_ID = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/;
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

function row(task: Task, nerd: boolean, columns: number): string {
  const g = nerd ? NERD_GLYPHS : ASCII_GLYPHS;
  const name = task.name ? task.name.slice(task.name.lastIndexOf(":") + 1) : task.label || task.type || "agent";
  const parts = [`${BOLD}${agentGlyph(name, nerd)} ${name}${RST}`];

  const model = friendlyModel(task.model || frontmatterModel(task.name ?? ""));
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
  return arrange(parts.map(block), columns, 1).join("");
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
  const nerd = detectNerdFont(process.env);
  const tasks: (Task | null)[] = Array.isArray(data?.tasks) ? data.tasks : [];
  const rows = tasks.flatMap((task) => (task?.id ? [`${JSON.stringify({ id: task.id, content: row(task, nerd, columns) })}\n`] : []));
  process.stdout.write(rows.join(""));
} catch {}
