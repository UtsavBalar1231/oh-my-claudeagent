import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseFrontmatter } from "../../src/core/frontmatter.ts";
import { type Check, type Context, listFiles, type Outcome, pass, relative, skip, verdict } from "./core.ts";

// The keys the platform reads for an agent or a skill. Claude Code loads an agent with an unknown
// key and names the key only in `--debug` output, and `claude plugin validate` does not flag one,
// so a misspelled `disallowedTools` would silently drop an agent's tool restrictions.
const AGENT_KEYS = new Set([
  "name", "description", "model", "effort", "maxTurns", "tools", "disallowedTools", "skills", "memory",
  "background", "omitClaudeMd", "isolation", "color", "experimental", "autoCompactWindow",
]);
const SKILL_KEYS = new Set([
  "name", "description", "when_to_use", "argument-hint", "arguments", "disable-model-invocation", "user-invocable",
  "allowed-tools", "disallowed-tools", "model", "effort", "context", "agent", "background", "hooks", "paths", "shell",
  "metadata", "license", "compatibility",
]);
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

export const DESCRIPTION_HARD_CAP = 1536;

const BLOCK_INDICATOR = /^[|>][+-]?\d?$/;

export function frontmatterLines(source: string): string[] | undefined {
  const lines = source.split(/\r?\n/);
  if (lines[0] !== "---") return undefined;
  const end = lines.indexOf("---", 1);
  return end === -1 ? lines.slice(1) : lines.slice(1, end);
}

export const topLevelKeys = (lines: readonly string[]): string[] =>
  lines.flatMap((line) => /^([A-Za-z_-]+):/.exec(line)?.[1] ?? []);

function unquote(value: string): string {
  const quote = value[0];
  if (value.length < 2 || value[value.length - 1] !== quote) return value;
  if (quote === '"') {
    try {
      return String(JSON.parse(value));
    } catch {
      return value.slice(1, -1);
    }
  }
  return quote === "'" ? value.slice(1, -1).replaceAll("''", "'") : value;
}

export function scalar(lines: readonly string[], key: string): string | undefined {
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start === -1) return undefined;
  const first = (lines[start] ?? "").slice(key.length + 1).trim();
  const folded: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") {
      if (BLOCK_INDICATOR.test(first)) folded.push("");
      continue;
    }
    if (!/^\s/.test(line)) break;
    folded.push(line.trim());
  }
  if (BLOCK_INDICATOR.test(first)) {
    const body = first.startsWith("|") ? folded.join("\n") : folded.join(" ");
    return body.trim();
  }
  return unquote([first, ...folded].filter((part) => part !== "").join(" "));
}

const agentFiles = (ctx: Context): string[] => listFiles(ctx.agentsDir, ".md");

function skillFiles(ctx: Context): string[] {
  return listFiles(ctx.skillsDir, "").flatMap((dir) => {
    const file = join(dir, "SKILL.md");
    return safeRead(file) === undefined ? [] : [file];
  });
}

function safeRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

const linesOf = (path: string): string[] => frontmatterLines(readFileSync(path, "utf8")) ?? [];

// A tools list is what brings Glob and Grep back on macOS, Linux and WSL, for an agent that leaves
// Bash out. It also drops every MCP tool it does not name, and `mcp__*` names none.
const OMCA_SERVER_TOOLS = "mcp__plugin_oh-my-claudeagent_omca__*";

function toolsProblems(name: string, path: string): string[] {
  const value = parseFrontmatter(readFileSync(path, "utf8"))?.tools;
  if (value === undefined) return [];
  const tools = (Array.isArray(value) ? value : value.split(",")).map((tool) => tool.trim());
  return [
    ...(tools.includes(OMCA_SERVER_TOOLS) ? [] : [`${name}: a tools list must name ${OMCA_SERVER_TOOLS}, or the agent loses the omca tools`]),
    ...(tools.includes("ToolSearch") ? [] : [`${name}: a tools list must name ToolSearch, or every omca tool loads up front`]),
    ...(tools.some((tool) => tool === "Bash" || tool === "PowerShell")
      ? [`${name}: a tools list is for an agent without a shell; restrict a shell agent with disallowedTools`]
      : []),
  ];
}

function agentHygiene(ctx: Context): Outcome {
  const files = agentFiles(ctx);
  if (files.length === 0) return { status: "fail", detail: `no agent files found in ${ctx.agentsDir}` };
  const problems: string[] = [];
  for (const file of files) {
    const lines = linesOf(file);
    const name = relative(ctx.root, file);
    problems.push(...toolsProblems(name, file));
    if ((scalar(lines, "name") ?? "").includes(":")) {
      problems.push(`${name}: name must not contain ':', the platform rejects the agent at load time`);
    }
    if (topLevelKeys(lines).includes("maxTurns")) {
      problems.push(`${name}: maxTurns truncates the agent mid-task, let it stop on its own conditions`);
    }
  }
  return verdict(problems, `${files.length} agents: tools lists keep the omca tools and no shell, no maxTurns and no colon in a name`);
}

function frontmatterKeys(ctx: Context): Outcome {
  const unknown: string[] = [];
  const files = [
    ...agentFiles(ctx).map((file) => ({ file, allowed: AGENT_KEYS })),
    ...skillFiles(ctx).map((file) => ({ file, allowed: SKILL_KEYS })),
  ];
  for (const { file, allowed } of files) {
    for (const key of topLevelKeys(linesOf(file))) {
      if (!allowed.has(key)) unknown.push(`${relative(ctx.root, file)}:${key}`);
    }
  }
  return verdict(
    unknown.length === 0 ? [] : [`the platform ignores these keys without an error (${unknown.join(" ")})`],
    `${files.length} agents and skills use only keys the platform reads`,
  );
}

function effortValues(ctx: Context): Outcome {
  const bad: string[] = [];
  const files = [...agentFiles(ctx), ...skillFiles(ctx)];
  for (const file of files) {
    const effort = scalar(linesOf(file), "effort");
    if (effort !== undefined && effort !== "" && !EFFORT_LEVELS.has(effort)) {
      bad.push(`${relative(ctx.root, file)}:${effort}`);
    }
  }
  return verdict(
    bad.length === 0 ? [] : [`effort values outside the platform enum (${bad.join(" ")})`],
    "every effort value is low, medium, high, xhigh or max",
  );
}

export function descriptionLength(lines: readonly string[]): number {
  const parts = [scalar(lines, "description"), scalar(lines, "when_to_use")].filter((part) => part !== undefined);
  return parts.join(" ").length;
}

function skillDescriptionCap(ctx: Context): Outcome {
  const files = skillFiles(ctx);
  if (files.length === 0) return skip("no SKILL.md files found under skills/");
  const over: string[] = [];
  for (const file of files) {
    const length = descriptionLength(linesOf(file));
    if (length > DESCRIPTION_HARD_CAP) over.push(`${basename(dirname(file))} (${length})`);
  }
  if (over.length > 0) {
    return { status: "fail", detail: `description plus when_to_use over the ${DESCRIPTION_HARD_CAP} character platform cap: ${over.join(", ")}` };
  }
  return pass(`${files.length} skills within ${DESCRIPTION_HARD_CAP} characters of description plus when_to_use`);
}

export const checks: readonly Check[] = [
  { name: "agent frontmatter", run: agentHygiene },
  { name: "frontmatter keys", run: frontmatterKeys },
  { name: "frontmatter effort", run: effortValues },
  { name: "skill description cap", run: skillDescriptionCap },
];
