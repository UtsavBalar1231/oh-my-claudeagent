import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isWindowsSafeName } from "../../src/core/session-id.ts";
import { ensureStateDir, projectRoot, withLock, writeFileAtomic } from "../io.ts";
import type { Tool } from "../omca.ts";

const SECTIONS = ["learnings", "issues", "decisions", "problems"] as const;
type Section = (typeof SECTIONS)[number];

const PLAN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WARN_BYTES = 50 * 1024;
const KEEP_LINES = 20;

const WORKING_DIRECTORY = { type: "string", default: "", description: "Project root (auto-detected from git)" };
const SECTION = { type: "string", enum: SECTIONS };

const isDir = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;

function stringArg(args: Record<string, unknown>, name: string, fallback?: string): string {
  const value = args[name] ?? fallback;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function toPlan(plan: string): string {
  if (!PLAN_NAME.test(plan) || !isWindowsSafeName(plan)) throw new Error(`plan_name must match ${PLAN_NAME.source}; got ${JSON.stringify(plan)}`);
  return plan;
}

function toSection(value: unknown): Section {
  const section = SECTIONS.find((candidate) => candidate === value);
  if (section === undefined) throw new Error(`section must be one of ${SECTIONS.join(", ")}; got ${JSON.stringify(value)}`);
  return section;
}

const rootOf = (args: Record<string, unknown>) => projectRoot(stringArg(args, "working_directory", "") || process.cwd());
const notepadsOf = (root: string) => join(root, ".omca", "notepads");

function sectionNames(dir: string): string {
  const names = readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => file.slice(0, -".md".length));
  return names.length > 0 ? names.join(", ") : "empty";
}

export const tools: Tool[] = [
  {
    name: "notepad_write",
    description:
      "Append content to a notepad section during plan execution. Use to record learnings, issues, decisions, or problems discovered while working. Always appends, never overwrites — safe to call multiple times. Returns confirmation with the updated section path.",
    inputSchema: {
      type: "object",
      properties: {
        plan_name: { type: "string", description: "Plan name (matches boulder plan_name)" },
        section: { ...SECTION, description: "Notepad section to write to" },
        content: { type: "string", description: "Content to append (markdown)" },
        working_directory: WORKING_DIRECTORY,
      },
      required: ["plan_name", "section", "content"],
    },
    annotations: {
      title: "Append to notepad",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    _meta: {
      "anthropic/searchHint": "persist a learning, issue, decision, or problem so it survives compaction",
      "anthropic/alwaysLoad": true,
    },
    call: async (args) => {
      const plan = toPlan(stringArg(args, "plan_name"));
      const section = toSection(args.section);
      const content = stringArg(args, "content");
      const root = rootOf(args);
      ensureStateDir(root);
      const path = join(notepadsOf(root), plan, `${section}.md`);
      const size = await withLock(`${path}.lock`, () => {
        const timestamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
        const next = `${existing}\n## ${timestamp}\n\n${content}\n`;
        writeFileAtomic(path, next);
        return Buffer.byteLength(next);
      });
      const result = `Appended to ${plan}/${section}.md`;
      if (size <= WARN_BYTES) return result;
      return `${result}\n[WARNING: section file is ${Math.floor(size / 1024)}KB — consider running notepad_compact to reduce size]`;
    },
  },
  {
    name: "notepad_read",
    description:
      "Read notepad content for a plan. Use to review discoveries, open questions, or prior decisions before continuing work on a plan. Omit section to read all sections at once. Returns formatted markdown content or a not-found message.",
    inputSchema: {
      type: "object",
      properties: {
        plan_name: { type: "string", description: "Plan name" },
        section: {
          anyOf: [SECTION, { type: "null" }],
          default: null,
          description: "Section to read (all if omitted)",
        },
        working_directory: WORKING_DIRECTORY,
      },
      required: ["plan_name"],
    },
    annotations: { title: "Read notepad", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    _meta: { "anthropic/searchHint": "recall learnings, issues, decisions, and problems recorded for a plan" },
    call: (args) => {
      const plan = toPlan(stringArg(args, "plan_name"));
      const section = args.section == null ? undefined : toSection(args.section);
      const dir = join(notepadsOf(rootOf(args)), plan);
      if (!isDir(dir)) return `No notepad found for plan: ${plan}`;
      const blocks = (section === undefined ? SECTIONS : [section]).flatMap((name) => {
        const path = join(dir, `${name}.md`);
        const title = name.charAt(0).toUpperCase() + name.slice(1);
        return isFile(path) ? [`# ${title}\n\n${readFileSync(path, "utf8")}`] : [];
      });
      return blocks.length > 0 ? blocks.join("\n---\n\n") : `No notepad entries found for plan: ${plan}`;
    },
  },
  {
    name: "notepad_list",
    description:
      "List available notepads and their sections. Use to discover which plans have notepad data or to verify a notepad was created. Provide plan_name to list sections for a specific plan, or omit to list all plans. Returns plan names with their available section names.",
    inputSchema: {
      type: "object",
      properties: {
        plan_name: { type: "string", default: "", description: "Plan name (lists all plans if empty)" },
        working_directory: WORKING_DIRECTORY,
      },
    },
    annotations: { title: "List notepads", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    _meta: { "anthropic/searchHint": "discover which plans have notepads and which sections exist" },
    call: (args) => {
      const plan = stringArg(args, "plan_name", "");
      const notepads = notepadsOf(rootOf(args));
      if (plan !== "") {
        const dir = join(notepads, toPlan(plan));
        return isDir(dir) ? `Plan: ${plan}\nSections: ${sectionNames(dir)}` : `No notepad found for plan: ${plan}`;
      }
      const plans = isDir(notepads) ? readdirSync(notepads).filter((name) => isDir(join(notepads, name))).sort() : [];
      if (plans.length === 0) return "No notepads found.";
      return ["Available notepads:\n", ...plans.map((name) => `- ${name}: ${sectionNames(join(notepads, name))}`)].join("\n");
    },
  },
  {
    name: "notepad_compact",
    description:
      "Permanently delete all but the last 20 lines of one notepad section. The cut is by line, not by entry, so an entry that straddles it loses its first lines and its timestamp header, and removed text is not archived anywhere. The section then starts with a marker giving the number of removed lines. Use it only when a section is too large to read usefully and its older entries no longer matter; read them with notepad_read first if they might. Returns a one-line summary, or a no-op message when the section has 20 lines or fewer.",
    inputSchema: {
      type: "object",
      properties: {
        plan_name: { type: "string", description: "Plan name (matches boulder plan_name)" },
        section: { ...SECTION, description: "Notepad section to compact" },
        working_directory: WORKING_DIRECTORY,
      },
      required: ["plan_name", "section"],
    },
    annotations: {
      title: "Compact notepad section",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    _meta: { "anthropic/searchHint": "truncate older entries in a large notepad section between plan phases" },
    call: async (args) => {
      const plan = toPlan(stringArg(args, "plan_name"));
      const section = toSection(args.section);
      const path = join(notepadsOf(rootOf(args)), plan, `${section}.md`);
      if (!existsSync(path)) return `Section '${section}' not found for plan '${plan}'`;
      return withLock(`${path}.lock`, () => {
        const lines = readFileSync(path, "utf8").trim().split("\n");
        if (lines.length <= KEEP_LINES) return `Section '${section}' has ${lines.length} lines — no compaction needed`;
        const removed = lines.length - KEEP_LINES;
        writeFileAtomic(path, `[Compacted: ${removed} earlier lines removed]\n${lines.slice(-KEEP_LINES).join("\n")}\n`);
        return `Compacted '${section}': removed ${removed} old lines, kept last ${KEEP_LINES}`;
      });
    },
  },
];
