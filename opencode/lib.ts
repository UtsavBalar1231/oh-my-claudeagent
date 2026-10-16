import { readFileSync } from "node:fs";
import { join } from "node:path";

const AGENT_STEMS = ["explorer", "architect", "researcher", "viewer", "analyzer", "reviewer", "build-fixer", "executor"];
const SKILL_DIRS = ["debugging", "remove-ai-slops", "refactor", "git-master", "handoff"];
const COMMAND_DIRS = ["analyzer", "reviewer", "build-fixer"];

type SourceKind = "agent" | "skill" | "command" | "outputStyle";
export type Source = { kind: SourceKind; key: string; relPath: string };

export function listSources(): Source[] {
  return [
    ...AGENT_STEMS.map((key): Source => ({ kind: "agent", key, relPath: `agents/${key}.md` })),
    ...SKILL_DIRS.map((key): Source => ({ kind: "skill", key, relPath: `skills/${key}/SKILL.md` })),
    ...COMMAND_DIRS.map((key): Source => ({ kind: "command", key, relPath: `skills/${key}/SKILL.md` })),
    { kind: "outputStyle", key: "output-style", relPath: "output-styles/omca-default.md" },
  ];
}

const COLORS: Record<string, string> = {
  red: "#ef4444", blue: "#3b82f6", green: "#22c55e", yellow: "#eab308",
  purple: "#a855f7", orange: "#f97316", pink: "#ec4899", cyan: "#06b6d4",
};

const DENY: Record<string, string> = {
  Agent: "subagent", Bash: "shell", Edit: "edit", Write: "edit", NotebookEdit: "edit",
  Glob: "glob", Grep: "grep", Skill: "skill",
};

const TOOLS: Record<string, string> = {
  Read: "read", Grep: "grep", Glob: "glob", Bash: "shell", Edit: "edit", Write: "write",
  Skill: "skill", Agent: "subagent", AskUserQuestion: "question", WebFetch: "webfetch", WebSearch: "websearch",
};

type Frontmatter = Record<string, unknown>;

export function splitFrontmatter(text: string, file: string): { data: Frontmatter; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (m?.[1] === undefined) return { data: {}, body: text };
  let data: unknown;
  try {
    data = Bun.YAML.parse(m[1]);
  } catch (err) {
    throw new Error(`${file}: frontmatter does not parse: ${err}`);
  }
  return { data: (data ?? {}) as Frontmatter, body: text.slice(m[0].length) };
}

type Heading = { line: number; level: number; text: string };

function headings(lines: string[]): Heading[] {
  const out: Heading[] = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (line.startsWith("```") || line.startsWith("~~~")) fenced = !fenced;
    const m = fenced ? null : /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) out.push({ line: i, level: m[1].length, text: m[2] });
  });
  return out;
}

export function dropSections(text: string, titles: string[]): string {
  let lines = text.split("\n");
  for (;;) {
    const hs = headings(lines);
    const h = hs.find((x) => titles.includes(x.text));
    if (h === undefined) return lines.join("\n");
    const end = hs.find((n) => n.line > h.line && n.level <= h.level)?.line ?? lines.length;
    lines = [...lines.slice(0, h.line), ...lines.slice(end)];
  }
}

function nativeNames(text: string): string {
  return text
    .replaceAll("oh-my-claudeagent:", "omca-")
    .replaceAll("mcp__plugin_oh-my-claudeagent_omca__", "omca_")
    .replaceAll("those go to build-fixer", "those go to omca-build-fixer")
    .replace(/`([A-Za-z]+)`/g, (match, name: string) => TOOLS[name] ? `\`${TOOLS[name]}\`` : match)
    .replace(/\b(evidence_log|notepad_write|notepad_read|boulder_progress|ast_search|ast_replace)\b/g, "omca_$1");
}

// Behavior comes from shared Markdown. Only host-only sections, names, and APIs differ.
export function projectBody(body: string): string {
  const common = dropSections(body, ["Claude Code", "Memory Guidance", "Worktree Isolation"]);
  return nativeNames(common).replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function str(data: Frontmatter, key: string, file: string): string {
  const value = data[key];
  if (typeof value !== "string") throw new Error(`${file}: frontmatter ${key} must be a string`);
  return value;
}

type PromptAgent = { id: string; tier: string; description: string; system: string; color?: string; deny: string[] };
type PromptSkill = { id: string; name: string; description: string; relPath: string; content: string; autoinvoke?: boolean };
type PromptCommand = { name: string; description: string; template: string };
export type Prompts = { agents: PromptAgent[]; skills: PromptSkill[]; commands: PromptCommand[]; outputStyle: string };

export function generate(root: string): Prompts {
  const agents: PromptAgent[] = [];
  const skills: PromptSkill[] = [];
  const commands: PromptCommand[] = [];
  let outputStyle = "";
  for (const src of listSources()) {
    const { data, body } = splitFrontmatter(readFileSync(join(root, src.relPath), "utf8"), src.relPath);
    const text = projectBody(body);
    if (!text.trim()) throw new Error(`${src.relPath}: no shared prompt body`);
    const id = `omca-${src.key}`;
    const description = nativeNames(str(data, "description", src.relPath));
    if (src.kind === "agent") {
      const names: unknown[] = Array.isArray(data.disallowedTools) ? data.disallowedTools : [];
      const deny = [...new Set(names.flatMap((n) => (typeof n === "string" ? (DENY[n] ?? []) : [])))].sort();
      const color = typeof data.color === "string" ? COLORS[data.color] : undefined;
      agents.push({
        id,
        tier: str(data, "model", src.relPath),
        description,
        system: text,
        ...(color ? { color } : {}),
        deny,
      });
    } else if (src.kind === "skill") {
      skills.push({
        id,
        name: id,
        description,
        relPath: src.relPath,
        content: text,
        ...(data["disable-model-invocation"] === true ? { autoinvoke: false } : {}),
      });
    } else if (src.kind === "command") {
      commands.push({
        name: id,
        description,
        template: `Use the subagent tool to launch ${id} with this prompt and return its actual result:\n\n${text}`,
      });
    } else {
      outputStyle = `${text}\nUse the native subagent foreground/background result and sessionID for continuation. Wait for the actual result; a launch acknowledgement is not a deliverable.\n`;
    }
  }
  return { agents, skills, commands, outputStyle };
}

export function parseModelRef(ref: unknown): { providerID: string; id: string; variant?: string } | undefined {
  if (typeof ref !== "string") return undefined;
  const match = /^([^/#]+)\/([^#]+?)(?:#([^#]+))?$/.exec(ref);
  const providerID = match?.[1];
  const id = match?.[2];
  if (!providerID || !id) return undefined;
  const variant = match?.[3];
  return { providerID, id, ...(variant ? { variant } : {}) };
}
