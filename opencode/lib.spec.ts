import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dropSections, generate, listSources, parseModelRef, projectBody, splitFrontmatter } from "./lib.ts";
import { COORDINATOR, EXECUTION, PLANNING, READ_ONLY_AGENTS } from "./workflows.ts";

const root = join(import.meta.dir, "..");
const data = generate(root);

function found<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} not found`);
  return value;
}

const agent = (id: string) => found(data.agents.find((a) => a.id === id), id);
const skill = (id: string) => found(data.skills.find((s) => s.id === id), id);

const FORBIDDEN: (string | RegExp)[] = [
  "ToolSearch", "AskUserQuestion", "SendMessage", "subagent_type", "oh-my-claudeagent:", "CLAUDE_PLUGIN_ROOT",
  "TaskCreate", "TaskList", "TodoWrite", "ExitPlanMode", "task-notification", "Agent(", "mcp__plugin_",
  "run_in_background", "CLAUDE.md", "Claude Code", "~/.claude", "<!--", /sisyphus/i, /prometheus/i,
  "permissions.blockReadsOutsideWorkingDirectories", "apply_patch",
  /\bBash\b/, /\b(Read|Edit|Write|Grep|Glob|WebFetch|WebSearch) tool\b/, /\b(Write|Edit|Agent)\//,
  /\b[a-z]+ Read\b(?!-)/, /\| (Read|Write|Edit) \|/, /\bRead\(/,
];

const TARGETS = "(explorer|architect|researcher|executor|build-fixer|analyzer|reviewer)";
const BARE_TARGET = new RegExp(
  `(\\b(spawn(ing)?|consult(ing)?|launch|recommend)\\s+(the\\s+)?|→\\s*|\\[\\s*)\`?${TARGETS}\\b(?!-)` +
    `|\\bgo to\\s+${TARGETS}\\b(?!-)|\\bwith\\s+${TARGETS}\\b(?![-\\w]|\\s+[a-z])|\\(${TARGETS}\\)|(?<!-)\\b${TARGETS} re-analysis`,
  "i",
);

const texts: [string, string][] = [
  ...data.agents.flatMap((a): [string, string][] => [[`${a.id} description`, String(a.description)], [`${a.id} system`, String(a.system)]]),
  ...data.skills.flatMap((s): [string, string][] => [[`${s.id} description`, String(s.description)], [`${s.id} content`, String(s.content)]]),
  ...data.commands.flatMap((c): [string, string][] => [[`${c.name} description`, String(c.description)], [`${c.name} template`, String(c.template)]]),
  ["outputStyle", data.outputStyle],
];

function hits(text: string, pattern: string | RegExp): string[] {
  return text.split("\n").filter((line) => (typeof pattern === "string" ? line.includes(pattern) : pattern.test(line)));
}

describe("generated prompts", () => {
  test("has no forbidden tokens", () => {
    const found = texts.flatMap(([where, text]) => FORBIDDEN.flatMap((p) => hits(text, p).map((line) => `${where} [${p}]: ${line}`)));
    expect(found).toEqual([]);
  });

  test("has no bare delegation targets", () => {
    const found = texts.flatMap(([where, text]) => hits(text, BARE_TARGET).map((line) => `${where}: ${line}`));
    expect(found).toEqual([]);
  });

  test("keeps shared metadata", () => {
    for (const src of listSources()) {
      const { data: fm } = splitFrontmatter(readFileSync(join(root, src.relPath), "utf8"), src.relPath);
      const id = `omca-${src.key}`;
      if (src.kind === "agent") expect(fm.model, id).toBe(agent(id).tier);
      const generated = src.kind === "agent" ? agent(id) : src.kind === "skill" ? skill(id) : data.commands.find((c) => c.name === id);
      if (generated && src.key !== "debugging") expect(fm.description, id).toBe(generated.description);
    }
    expect(skill("omca-debugging").description).toContain("those go to omca-build-fixer");
  });

  test("shared body edits reach every native agent, skill, command, and output style", () => {
    const fixture = mkdtempSync(join(tmpdir(), "omca-shared-prompts-"));
    try {
      for (const src of listSources()) {
        const path = join(fixture, src.relPath);
        mkdirSync(dirname(path), { recursive: true });
        const marker = `Shared behavior from ${src.relPath} reaches this prompt.`;
        writeFileSync(path, `${readFileSync(join(root, src.relPath), "utf8")}\n## Shared behavior\n\n${marker}\n`);
      }
      const updated = generate(fixture);
      for (const src of listSources()) {
        const id = `omca-${src.key}`;
        const text = src.kind === "agent" ? found(updated.agents.find((a) => a.id === id), id).system
          : src.kind === "skill" ? found(updated.skills.find((s) => s.id === id), id).content
          : src.kind === "command" ? found(updated.commands.find((c) => c.name === id), id).template
          : updated.outputStyle;
        expect(text, src.relPath).toContain(`Shared behavior from ${src.relPath} reaches this prompt.`);
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("native bodies stay within reviewable body budgets", () => {
    const bodies: string[] = [];
    for (const a of data.agents) {
      expect(a.system.length, a.id).toBeLessThanOrEqual(3000);
      bodies.push(a.system);
    }
    for (const s of data.skills) {
      expect(s.content.length, s.id).toBeLessThanOrEqual(3000);
      bodies.push(s.content);
    }
    for (const c of data.commands) {
      expect(c.template.length, c.name).toBeLessThanOrEqual(1800);
      expect(c.template, c.name).toContain(`subagent tool to launch ${c.name}`);
      expect(c.template, c.name).toContain("$ARGUMENTS");
      bodies.push(c.template);
    }
    expect(data.outputStyle.length).toBeLessThanOrEqual(3000);
    bodies.push(data.outputStyle);
    expect(bodies.reduce((total, body) => total + body.length, 0)).toBeLessThanOrEqual(30000);
    for (const body of bodies) {
      expect(body.trim()).not.toBe("");
      expect(body).not.toMatch(/Required output format|PHASE \d|Every response must|\badvisor\b/i);
    }
  });

  test("leaf and read-only roles keep their boundaries", () => {
    for (const a of data.agents) {
      expect(a.deny, a.id).toContain("subagent");
      expect(a.system, a.id).toMatch(/do not delegate|or delegat(?:e|ing)/i);
    }
    for (const id of ["explorer", "architect", "researcher", "viewer", "analyzer"]) {
      expect(agent(`omca-${id}`).system, id).toMatch(/read-only|without changing files/i);
    }
    for (const id of READ_ONLY_AGENTS) {
      expect(agent(id).system, id).not.toMatch(/\bomca_notepad_(write|compact)\b/);
    }
    expect(agent("omca-reviewer").system).toContain("only when the user explicitly asks and the host permits it");
    expect(agent("omca-reviewer").system).toContain("Do not modify source code");
    expect(agent("omca-architect").system).toContain("`omca-build-fixer` for compile");
    expect(agent("omca-build-fixer").system).toContain("runtime behavior changes to `omca-executor`");
    expect(agent("omca-researcher").system).toContain("Do not guess APIs or invent citations");
    expect(agent("omca-researcher").system).toContain("commit-pinned links");
    expect(agent("omca-viewer").system).toContain("Report confidence and limitations");
  });

  test("worker retry ceilings survive projection with immediate safety escalation", () => {
    for (const [id, ceiling] of [["executor", "three"], ["build-fixer", "five"]]) {
      const rule = agent(`omca-${id}`).system.match(/After (three|five) .*?attempts[^.]*\./);
      expect(rule?.[1], id).toBe(ceiling);
      expect(rule?.[0], id).toMatch(/stop.*primary agent/);
      expect(rule?.[0], id).toMatch(/immediately.*unsafe.*out of scope/);
    }
    expect(agent("omca-executor").system).toContain("sooner when a skill requires it");
  });

  test("coordinator acceptance review comes once from the shared output style", () => {
    const source = readFileSync(join(root, "output-styles/omca-default.md"), "utf8");
    const paragraphs = splitFrontmatter(source, "output style").body.split(/\n\n/);
    const rules = paragraphs.filter((paragraph) => /delegated implementation/.test(paragraph));
    expect(rules).toHaveLength(1);
    const rule = projectBody(found(rules[0], "acceptance review")).trim();
    expect(rule).toMatch(/independently.*diff.*rerun.*acceptance checks/);
    expect(rule).toMatch(/final.*requirements and exclusions.*full diff.*final checks/);
    const context = `${data.outputStyle}\n${COORDINATOR}\n${EXECUTION}`;
    expect(context.split(rule)).toHaveLength(2);
    expect(context.match(/foreground\/background/g)).toHaveLength(1);
  });

  test("native planning respects the reviewer's saved-path prerequisite", () => {
    const rule = PLANNING.split("\n").find((line) => line.includes("omca-reviewer"));
    expect(rule).toMatch(/only with an authoritative saved plan path/);
    expect(rule).toMatch(/otherwise self-review.*without creating a file/);
    expect(PLANNING).toMatch(/Write a plan file only if the user explicitly requests one/);
  });

  test("debugging requires a reproducer before a behavior change", () => {
    const text = skill("omca-debugging").content;
    expect(text).toContain("Reproduce the runtime failure before changing behavior");
    expect(text).toContain("Change only the confirmed cause");
    expect(text).toContain("Rerun the same reproducer and nearby affected behavior");
    expect(text).toContain("two failed fix attempts");
  });

  test("executor requires observable verification and honest exits", () => {
    const text = agent("omca-executor").system;
    expect(text).toContain("clean typecheck alone does not prove it works");
    expect(text).toContain("`omca_evidence_log` with the real exit code");
    expect(text).toContain("If a check cannot run, say why");
    expect(text).toContain("Recheck after further edits");
  });

  test("handoff stays user-requested, compact, and read-only", () => {
    const text = skill("omca-handoff").content;
    expect(text).toContain("only when the user explicitly asks");
    expect(text).toContain("long conversation alone is not authorization");
    expect(text).toContain("Read-only");
    expect(text).toContain("do not change files, register or bind a plan");
    expect(text).toContain("do not select another session's plan");
    expect(text).toContain("dump metadata or transcripts");
  });

  test("git inspection cannot authorize commits or destructive discard", () => {
    const text = skill("omca-git-master").content;
    expect(text).toContain("inspection and history search are read-only");
    expect(text).toContain("Do not commit or push unless explicitly requested");
    expect(text).toContain("Stashing or discarding work is the user's step");
    expect(text).toContain("Do not run reset --hard, checkout --, restore, clean, or stash");
    expect(text).toContain("--force-with-lease, never --force");
    expect(text).toContain("name a recovery path");
  });

  test("refactor and cleanup retain behavior and load-bearing protection", () => {
    const refactor = skill("omca-refactor").content;
    expect(refactor).toContain("Preserve behavior");
    expect(refactor).toContain("Run a baseline");
    expect(refactor).toContain("tests and typechecks after each step");
    expect(refactor).toContain("Do not continue past a failure");
    const cleanup = skill("omca-remove-ai-slops").content;
    expect(cleanup).toContain("test an adversarial input and prove the remaining path handles the same failure");
    expect(cleanup).toContain("No proof means no deletion");
    expect(cleanup).toContain("Do not introduce replacement abstractions");
    expect(cleanup).toContain("license/SPDX and file/module headers");
  });

  test("native file tools honor permissions", () => {
    expect(data.outputStyle).toContain("Custom tools do not bypass the host's permissions");
    expect(data.outputStyle).toContain("historical evidence from current-checkout verification");
  });

  test("agent fields", () => {
    const explore = agent("omca-explorer");
    expect("steps" in explore).toBe(false);
    expect(explore.deny).toEqual(["edit", "subagent"]);
    expect(explore.color).toBe("#3b82f6");
    expect(explore.tier).toBe("sonnet");
    expect(agent("omca-viewer").tier).toBe("opus");
    expect(agent("omca-architect").tier).toBe("fable");
  });

  test("skill fields", () => {
    expect(skill("omca-handoff").name).toBe("omca-handoff");
    expect(skill("omca-handoff").autoinvoke).toBe(false);
    expect("autoinvoke" in skill("omca-debugging")).toBe(false);
  });
});

test("projection changes host names and APIs without replacing shared behavior", () => {
  const source = "Keep the exact failure observable. Use `Read`, `Bash`, `Skill`, and `AskUserQuestion`; call `evidence_log`. Recommend `oh-my-claudeagent:architect`.\n";
  expect(projectBody(source)).toBe("Keep the exact failure observable. Use `read`, `shell`, `skill`, and `question`; call `omca_evidence_log`. Recommend `omca-architect`.\n");
});

test("projection strips only Claude-specific sections, not later shared sections", () => {
  const source = "# Role\n\nKeep shared behavior.\n\n## Claude Code\n\nUse `advisor`.\n\n## Memory Guidance\n\nUse Claude-native memory.\n\n## Shared checks\n\nKeep verification.\n\n## Worktree Isolation\n\nUse isolation.\n";
  expect(projectBody(source)).toBe("# Role\n\nKeep shared behavior.\n\n## Shared checks\n\nKeep verification.\n");
});

test("heading detection toggles on every fence line", () => {
  expect(dropSections("## Keep\n\n```\n## Memory Guidance\n```\n", ["Memory Guidance"])).toContain("## Memory Guidance");
  expect(dropSections("## Keep\n\n~~~\n## Memory Guidance\n~~~\n", ["Memory Guidance"])).toContain("## Memory Guidance");
});

test("BARE_TARGET catches noun-position agent names but not the verb explore", () => {
  for (const s of ["those go to build-fixer", "Boundary with build-fixer", "architecture (architect)", "running analyzer re-analysis"]) {
    expect(BARE_TARGET.test(s), s).toBe(true);
  }
  for (const s of ["explore patterns first", "with omca-build-fixer", "(omca-architect)", "go to explore-heavy work", "omca-analyzer re-analysis", "with executor acknowledgment"]) {
    expect(BARE_TARGET.test(s), s).toBe(false);
  }
});

test("FORBIDDEN catches Claude Code tool names but not the verbs or Read-only", () => {
  const caught = (s: string) => FORBIDDEN.some((p) => (typeof p === "string" ? s.includes(p) : p.test(s)));
  for (const s of ["No Write/Edit/Agent.", "Otherwise work from Read alone.", "| Read | Plan files |", "`Read(file_path)`"]) expect(caught(s), s).toBe(true);
  for (const s of ["Read-only advisor.", "Read the target files first.", "Write the final report.", "| Read file contents | `read` |"]) expect(caught(s), s).toBe(false);
});

test("parseModelRef", () => {
  expect(parseModelRef("anthropic/claude-opus-5-5#high")).toEqual({ providerID: "anthropic", id: "claude-opus-5-5", variant: "high" });
  expect(parseModelRef("anthropic/claude-opus-5-5")).toEqual({ providerID: "anthropic", id: "claude-opus-5-5" });
  expect(parseModelRef("bad")).toBeUndefined();
  expect(parseModelRef("/x")).toBeUndefined();
  expect(parseModelRef(42)).toBeUndefined();
  for (const value of ["openai/gpt#", "openai/gpt#high#low", "openai#alias/gpt"]) expect(parseModelRef(value)).toBeUndefined();
  expect(parseModelRef("openrouter/anthropic/model#high")).toEqual({ providerID: "openrouter", id: "anthropic/model", variant: "high" });
});

test("package.json version matches plugin.json", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
  expect(pkg.version).toBe(plugin.version);
});

test("package installs resolve the exact SDK used for validation", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  expect(pkg.peerDependencies["@opencode/plugin"]).toBe(pkg.devDependencies["@opencode/plugin"]);
});
