import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const AGENT_STEMS = ["explore", "oracle", "librarian", "multimodal-looker", "metis", "momus", "hephaestus", "executor"];
export const SKILL_DIRS = ["debugging", "remove-ai-slops", "refactor", "git-master", "handoff"];
export const COMMAND_DIRS = ["metis", "momus", "hephaestus"];

export type SourceKind = "agent" | "skill" | "command" | "outputStyle";
export type Source = { kind: SourceKind; key: string; relPath: string; overlay?: string };

export function listSources(): Source[] {
  return [
    ...AGENT_STEMS.map((key): Source => ({ kind: "agent", key, relPath: `agents/${key}.md`, overlay: key })),
    ...SKILL_DIRS.map((key): Source => ({ kind: "skill", key, relPath: `skills/${key}/SKILL.md`, overlay: key })),
    ...COMMAND_DIRS.map((key): Source => ({ kind: "command", key, relPath: `skills/${key}/SKILL.md` })),
    { kind: "outputStyle", key: "output-style", relPath: "output-styles/omca-default.md", overlay: "output-style" },
  ];
}

export const PHRASES: [string, string][] = [
  [", plus `TaskList()` counts where that tool exists", ""],
  [", and from `TaskList()` state where that tool exists", ""],
  [", supplemented by `TaskList()` where available", ""],
  ["[oracle | sisyphus]", "[omca-oracle | the primary agent]"],
  ["Recommend consulting oracle", "Recommend consulting omca-oracle"],
  ["consult oracle", "consult the omca-oracle subagent"],
  ["Consult oracle", "Consult the omca-oracle subagent"],
  ["Recommend oracle", "Recommend omca-oracle"],
  ["Recommend hephaestus", "Recommend omca-hephaestus"],
  ["Recommend executor", "Recommend omca-executor"],
  ["(use explore)", "(use omca-explore)"],
  ["→ oracle", "→ omca-oracle"],
  ["→ hephaestus", "→ omca-hephaestus"],
  ["→ executor", "→ omca-executor"],
  ["explore/librarian agents", "omca-explore/omca-librarian subagents"],
  ["in explore prompts", "in omca-explore prompts"],
  ["`${CLAUDE_PLUGIN_ROOT}/agents/momus.md`", "the omca-momus agent instructions"],
  [" and the guidance OMCA adds to the session's first prompt", ""],
  ["## Bash Usage Policy", "## Shell Usage Policy"],
  [": Read numbers the lines", ": the read tool numbers the lines"],
  ["the omca `file_read` MCP tool", "`file_read`"],
  ["those go to hephaestus", "those go to omca-hephaestus"],
  ["## Boundary with hephaestus", "## Boundary with omca-hephaestus"],
  ["feature implementation (executor), architecture (oracle), refactoring (executor)", "feature implementation (omca-executor), architecture (omca-oracle), refactoring (omca-executor)"],
  ["running metis re-analysis", "running omca-metis re-analysis"],
];

const DELEGATES = ["explore", "oracle", "librarian", "executor", "hephaestus", "metis", "momus", "multimodal-looker"];

export const TOKENS: [string, string][] = [
  ["oh-my-claudeagent:", "omca-"],
  ["AskUserQuestion", "question"],
  ["`Skill`", "`skill`"],
  ["`Agent`", "`subagent`"],
  ["`Bash`", "`shell`"],
  ...["Read", "Edit", "Write", "Grep", "Glob", "WebFetch", "WebSearch"].map((t): [string, string] => [`\`${t}\``, `\`${t.toLowerCase()}\``]),
  ["mcp__plugin_oh-my-claudeagent_omca__", "omca_"],
  ...DELEGATES.map((n): [string, string] => [`\`${n}\``, `\`omca-${n}\``]),
];

const OMCA_TOOLS = /\b(evidence_log|evidence_read|notepad_write|notepad_read|notepad_list|notepad_compact|boulder_write|boulder_progress|ast_search|ast_find_rule|ast_test_rule|ast_dump_tree|ast_replace|file_read|session_search|agents_list|categories_list|health_check)\b/g;

export const FORBIDDEN: (string | RegExp)[] = [
  "ToolSearch", "AskUserQuestion", "SendMessage", "subagent_type", "oh-my-claudeagent:", "CLAUDE_PLUGIN_ROOT",
  "TaskCreate", "TaskList", "TodoWrite", "ExitPlanMode", "task-notification", "Agent(", "mcp__plugin_",
  "run_in_background", "CLAUDE.md", "~/.claude", "omca-plan", "omca-start-work", "<!--", /sisyphus/i, /prometheus/i,
  /\bBash\b/, /\b(Read|Edit|Write|Grep|Glob|WebFetch|WebSearch) tool\b/,
];

const TARGETS = "(explore|oracle|librarian|executor|hephaestus|metis|momus)";
export const BARE_TARGET = new RegExp(
  `(\\b(spawn(ing)?|consult(ing)?|launch|recommend)\\s+(the\\s+)?|→\\s*|\\[\\s*)\`?${TARGETS}\\b(?!-)` +
    `|\\bgo to\\s+${TARGETS}\\b(?!-)|\\bwith\\s+${TARGETS}\\b(?![-\\w]|\\s+[a-z])|\\(${TARGETS}\\)|(?<!-)\\b${TARGETS} re-analysis`,
  "i",
);

const COLORS: Record<string, string> = {
  red: "#ef4444", blue: "#3b82f6", green: "#22c55e", yellow: "#eab308",
  purple: "#a855f7", orange: "#f97316", pink: "#ec4899", cyan: "#06b6d4",
};

const DENY: Record<string, string> = {
  Agent: "subagent", Bash: "shell", Edit: "edit", Write: "edit", NotebookEdit: "edit",
  Glob: "glob", Grep: "grep", Skill: "skill",
};

type Frontmatter = Record<string, unknown>;

export function splitFrontmatter(text: string, file: string): { data: Frontmatter; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return { data: {}, body: text };
  let data: unknown;
  try {
    data = Bun.YAML.parse(m[1]!);
  } catch (err) {
    throw new Error(`${file}: frontmatter does not parse: ${err}`);
  }
  return { data: (data ?? {}) as Frontmatter, body: text.slice(m[0].length) };
}

type Heading = { line: number; level: number; text: string };

// A simple toggle, not CommonMark nesting: agents/librarian.md nests fences, and nesting would hide a later heading.
function headings(lines: string[]): Heading[] {
  const out: Heading[] = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (line.startsWith("```") || line.startsWith("~~~")) fenced = !fenced;
    const m = fenced ? null : /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (m) out.push({ line: i, level: m[1]!.length, text: m[2]! });
  });
  return out;
}

function sectionEnd(hs: Heading[], index: number, total: number): number {
  const h = hs[index]!;
  return hs.slice(index + 1).find((n) => n.level <= h.level)?.line ?? total;
}

function trimBlankEnd(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end--;
  return lines.slice(0, end);
}

export function dropSections(text: string, titles: string[]): string {
  let lines = text.split("\n");
  for (;;) {
    const hs = headings(lines);
    const i = hs.findIndex((h) => titles.includes(h.text));
    if (i < 0) return lines.join("\n");
    lines = [...lines.slice(0, hs[i]!.line), ...lines.slice(sectionEnd(hs, i, lines.length))];
  }
}

export function applyOverlay(source: string, overlay: string): { text: string; missing: string[] } {
  const oLines = overlay.split("\n");
  const oHs = headings(oLines);
  const blocks: { level: number; text: string; lines: string[] }[] = [];
  for (let i = 0; i < oHs.length; ) {
    const end = sectionEnd(oHs, i, oLines.length);
    blocks.push({ level: oHs[i]!.level, text: oHs[i]!.text, lines: trimBlankEnd(oLines.slice(oHs[i]!.line, end)) });
    const next = oHs.findIndex((h) => h.line >= end);
    i = next < 0 ? oHs.length : next;
  }
  let lines = source.split("\n");
  const missing: string[] = [];
  for (const block of blocks) {
    const hs = headings(lines);
    const i = hs.findIndex((h) => h.level === block.level && h.text === block.text);
    if (i < 0) {
      missing.push(`${"#".repeat(block.level)} ${block.text}`);
      continue;
    }
    const end = sectionEnd(hs, i, lines.length);
    lines = [...lines.slice(0, hs[i]!.line), ...block.lines, "", ...lines.slice(end)];
  }
  return { text: lines.join("\n"), missing };
}

export function stripSource(body: string): string {
  return dropSections(body.replace(/<!--[\s\S]*?-->\n?/g, ""), ["Memory Guidance", "Worktree Isolation"]);
}

export function prepare(root: string, src: Source): { data: Frontmatter; text: string } {
  const { data, body } = splitFrontmatter(readFileSync(join(root, src.relPath), "utf8"), src.relPath);
  let text = stripSource(body);
  const overlayPath = src.overlay && join(root, "opencode/overlays", `${src.overlay}.md`);
  if (overlayPath && existsSync(overlayPath)) {
    const result = applyOverlay(text, readFileSync(overlayPath, "utf8"));
    if (result.missing.length) throw new Error(`${overlayPath}: headings not in ${src.relPath}: ${result.missing.join(", ")}`);
    text = result.text;
  }
  return { data, text };
}

export function translate(text: string): string {
  for (const [from, to] of [...PHRASES, ...TOKENS]) text = text.replaceAll(from, to);
  const article = (m: string, at: number, s: string) =>
    m.startsWith("The") || (!/^the\s/i.test(m) && /(^|[.!?]\s+|\n)$/.test(s.slice(Math.max(0, at - 3), at))) ? "The" : "the";
  return text
    .replace(/\b(the\s+)?sisyphus\b/gi, (m, _the, at: number, s: string) => `${article(m, at, s)} primary agent`)
    .replace(/\b(the\s+)?prometheus\b/gi, (m, _the, at: number, s: string) => `${article(m, at, s)} planner`)
    .replace(OMCA_TOOLS, "omca_$1")
    .replace(/\b(Read|Edit|Write|Grep|Glob|WebFetch|WebSearch) tool\b/g, (_m, t: string) => `${t.toLowerCase()} tool`)
    .replace(/\bBash\b/g, "shell");
}

function body(text: string): string {
  return translate(text).replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function str(data: Frontmatter, key: string, file: string): string {
  const value = data[key];
  if (typeof value !== "string") throw new Error(`${file}: frontmatter ${key} must be a string`);
  return value;
}

export type PromptAgent = { id: string; tier: string; description: string; system: string; steps?: number; color?: string; deny: string[] };
export type PromptSkill = { id: string; name: string; description: string; relPath: string; content: string; autoinvoke?: boolean };
export type PromptCommand = { name: string; description: string; template: string };
export type Prompts = { agents: PromptAgent[]; skills: PromptSkill[]; commands: PromptCommand[]; outputStyle: string };

export function generate(root: string): Prompts {
  const agents: PromptAgent[] = [];
  const skills: PromptSkill[] = [];
  const commands: PromptCommand[] = [];
  let outputStyle = "";
  for (const src of listSources()) {
    const { data, text } = prepare(root, src);
    const id = `omca-${src.key}`;
    if (src.kind === "agent") {
      const names: unknown[] = Array.isArray(data.disallowedTools) ? data.disallowedTools : [];
      const deny = [...new Set(names.flatMap((n) => (typeof n === "string" && DENY[n] ? [DENY[n]] : [])))].sort();
      const color = typeof data.color === "string" ? COLORS[data.color] : undefined;
      agents.push({
        id,
        tier: str(data, "model", src.relPath),
        description: translate(str(data, "description", src.relPath)),
        system: body(text),
        ...(typeof data.maxTurns === "number" ? { steps: data.maxTurns } : {}),
        ...(color ? { color } : {}),
        deny,
      });
    } else if (src.kind === "skill") {
      skills.push({
        id,
        name: id,
        description: translate(str(data, "description", src.relPath)),
        relPath: src.relPath,
        content: body(text),
        ...(data["disable-model-invocation"] === true ? { autoinvoke: false } : {}),
      });
    } else if (src.kind === "command") {
      commands.push({
        name: id,
        description: translate(str(data, "description", src.relPath)),
        template: `Launch the ${id} subagent with this prompt:\n\n${body(text)}`,
      });
    } else {
      outputStyle = body(text);
    }
  }
  return { agents, skills, commands, outputStyle };
}

export function parseModelRef(ref: unknown): { providerID: string; id: string; variant?: string } | undefined {
  if (typeof ref !== "string") return undefined;
  const slash = ref.indexOf("/");
  if (slash <= 0) return undefined;
  const rest = ref.slice(slash + 1);
  const hash = rest.lastIndexOf("#");
  const id = hash < 0 ? rest : rest.slice(0, hash);
  if (!id) return undefined;
  const variant = hash < 0 ? "" : rest.slice(hash + 1);
  return { providerID: ref.slice(0, slash), id, ...(variant ? { variant } : {}) };
}
