import { clean, FENCE, TASK_LINE } from "./checkboxes.ts";
import { configDir, type Env, expandTilde, homeDir, isAbsolutePath, isInside, joinPath, normalizePath, type Platform, toPosix } from "./path.ts";

export { clean } from "./checkboxes.ts";

export type Task = { n: number; done: boolean };
export type Page = { title: string; level: number; body: string; task?: Task };
export type Plan = { title: string; pages: Page[]; done: number; total: number };
export type PlanFile = { name: string; path: string; mtimeMs: number };

// The Markdown element refuses text over 10,000 characters; the margin keeps a split line safe.
export const MARKDOWN_CHUNK = 9_000;
const RECENT_PLANS = 30;
export const CONTENTS_CAP = 400;

const HEADING = /^(#{1,3})\s+(.+?)\s*#*\s*$/;

export function parsePlan(source: string): Plan {
  const pages: Page[] = [];
  const buffer: string[] = [];
  let title = "";
  let current: Page = { title: "Overview", level: 2, body: "" };
  let inFence = false;
  let done = 0;
  let total = 0;

  // Markdown draws a `- [ ] 3. text` line as a stray `-` and a nested list, so a task page
  // drops its checkbox line and un-indents its details.
  const flush = (next: Page) => {
    const lines = current.task === undefined ? buffer : buffer.map((line) => line.replace(/^ {2}/, ""));
    pages.push({ ...current, body: lines.join("\n").trim() });
    buffer.length = 0;
    current = next;
  };

  for (const line of clean(source).split("\n")) {
    if (FENCE.test(line)) inFence = !inFence;
    const heading = inFence ? null : HEADING.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 2;
      const text = heading[2] ?? "";
      if (level === 1 && title === "") {
        title = text;
        continue;
      }
      flush({ title: text, level, body: "" });
      continue;
    }
    const task = inFence ? null : TASK_LINE.exec(line);
    if (task) {
      const isDone = task[1] === "x";
      total += 1;
      if (isDone) done += 1;
      flush({ title: `${task[2]}. ${task[3] ?? ""}`, level: 4, body: "", task: { n: Number(task[2]), done: isDone } });
      continue;
    }
    buffer.push(line);
  }
  flush(current);

  const [overview, ...rest] = pages;
  const kept = overview !== undefined && overview.body !== "" ? pages : rest;
  return { title: title === "" ? "Plan" : title, pages: kept, done, total };
}

export function isReadable(page: Page): boolean {
  return page.body !== "" || page.task !== undefined;
}

export function readable(plan: { readonly pages: readonly Page[] }): number[] {
  return plan.pages.flatMap((page, index) => (isReadable(page) ? [index] : []));
}

export function chunks(body: string, limit = MARKDOWN_CHUNK): string[] {
  const out: string[] = [];
  let current = "";
  for (const line of body.split("\n")) {
    for (let start = 0; start === 0 || start < line.length; start += limit) {
      const piece = line.slice(start, start + limit);
      if (current !== "" && current.length + piece.length + 1 > limit) {
        out.push(current);
        current = "";
      }
      current = current === "" ? piece : `${current}\n${piece}`;
    }
  }
  if (current !== "") out.push(current);
  return out;
}

export function firstOpenTask(plan: { readonly pages: readonly Page[] }): number {
  const open = plan.pages.findIndex((page) => page.task !== undefined && !page.task.done);
  return open >= 0 ? open : (readable(plan)[0] ?? 0);
}

export type Field = { name: string; text: string };
export type Card = {
  n: number;
  done: boolean;
  title: string;
  group: number;
  page: number;
  fields: Field[];
  files: string[];
  depends: number[];
  checks: string[];
};
export type Group = { title: string; tasks: number[] };
export type Board = { status: "FINAL" | "DRAFT" | null; groups: Group[]; cards: Card[] };

const FIELD = /^- ([A-Z][\w ()-]*?):\s*(.*)$/;
const STATUS = /\*{0,2}Status\*{0,2}:\s*\*{0,2}\s*(FINAL|DRAFT)\b/i;
const SPAN = /`([^`]+)`/g;
const GLOB = /[*?{}<>$|]/;

/** A task's `- Name: text` sub-bullets in order; deeper lines continue the field above them. */
export function fieldsOf(body: string): Field[] {
  const fields: Field[] = [];
  for (const line of body.split("\n")) {
    const field = FIELD.exec(line);
    const last = fields.at(-1);
    if (field !== null) fields.push({ name: field[1] ?? "", text: (field[2] ?? "").trim() });
    else if (last !== undefined && line.trim() !== "") last.text = `${last.text}\n${line.trim()}`;
    else if (line.trim() !== "") fields.push({ name: "", text: line.trim() });
  }
  return fields;
}

// Commas inside parentheses belong to an annotation such as `(new, generated)`.
function segments(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      out.push(current);
      current = "";
    } else current += char;
  }
  return [...out, current].map((part) => part.trim()).filter((part) => part !== "");
}

/**
 * The paths a `File:` line lists: the first code span of each comma-separated item, or its first
 * word when the line has no code spans. Directories, globs and annotations are left out.
 */
export function pathsOf(text: string): string[] {
  const hasSpans = text.includes("`");
  const paths = segments(text).flatMap((part) => {
    const path = hasSpans ? (/`([^`]+)`/.exec(part)?.[1] ?? "") : (part.split(/\s+/)[0] ?? "");
    const isPath = path !== "" && !/\s/.test(path) && !GLOB.test(path) && !path.endsWith("/") && (hasSpans || /[./]/.test(path));
    return isPath ? [path] : [];
  });
  return [...new Set(paths)];
}

/** The code spans of a `Done when:` line that read as commands: those with an argument. */
export function checksOf(text: string): string[] {
  return [...text.matchAll(SPAN)].map((match) => (match[1] ?? "").trim()).filter((span) => /\s/.test(span));
}

const fieldText = (fields: readonly Field[], ...names: string[]) =>
  fields.filter((field) => names.includes(field.name.toLowerCase())).map((field) => field.text).join(", ");

/** The plan as a board: its Status, its tasks, and the `##`/`###` headings that hold them. */
export function boardOf(plan: { readonly pages: readonly Page[] }): Board {
  const groups: Group[] = [];
  const cards: Card[] = [];
  let status: Board["status"] = null;
  let heading = "Tasks";
  let open: Group | undefined;
  for (const [page, section] of plan.pages.entries()) {
    const { task } = section;
    if (task === undefined) {
      if (cards.length === 0 && status === null) {
        const found = STATUS.exec(section.body)?.[1]?.toUpperCase();
        if (found === "FINAL" || found === "DRAFT") status = found;
      }
      if (section.level <= 3) {
        heading = section.title;
        open = undefined;
      }
      continue;
    }
    if (open === undefined) {
      open = { title: heading, tasks: [] };
      groups.push(open);
    }
    open.tasks.push(task.n);
    const fields = fieldsOf(section.body);
    cards.push({
      n: task.n,
      done: task.done,
      title: section.title.replace(/^\d+\.\s*/, ""),
      group: groups.length - 1,
      page,
      fields,
      files: pathsOf(fieldText(fields, "file", "files")),
      depends: [...(fieldText(fields, "depends", "depends on").match(/\b\d+\b/g) ?? [])].map(Number),
      checks: checksOf(fieldText(fields, "done when")),
    });
  }
  const known = new Set(cards.map((card) => card.n));
  for (const card of cards) card.depends = [...new Set(card.depends)].filter((n) => n !== card.n && known.has(n));
  return { status, groups, cards };
}

/** The task a delegation names on its first line (`Task 43: …`), else in its description. */
export function taskReference(prompt: string, description = ""): number | undefined {
  const named = (text: string) => /\btask\s+#?(\d+)\b/i.exec(text)?.[1];
  const found = named(prompt.trimStart().split("\n")[0] ?? "") ?? named(description);
  return found === undefined ? undefined : Number(found);
}

/** The task as the plan writes it, for the clipboard. */
export function taskMarkdown(card: Card, body: string): string {
  const head = `- [${card.done ? "x" : " "}] ${card.n}. ${card.title}`;
  return body === "" ? head : `${head}\n${body.split("\n").map((line) => (line === "" ? "" : `  ${line}`)).join("\n")}`;
}

// `plansDirectory` resolves against the project root, and the client keeps its default,
// `<config dir>/plans`, when the setting is unset or resolves outside the root. It is undefined
// when that default cannot be located.
export function plansDirectory(platform: Platform, setting: unknown, root: string, env: Env): string | undefined {
  const config = configDir(env);
  const fallback = config === undefined ? undefined : joinPath(platform, config, "plans");
  if (typeof setting !== "string" || setting.trim() === "") return fallback;
  const expanded = expandTilde(platform, setting.trim(), homeDir(env));
  if (expanded === undefined) return fallback;
  const resolved = isAbsolutePath(platform, expanded) ? normalizePath(platform, expanded) : joinPath(platform, root, expanded);
  return isInside(platform, root, resolved) ? resolved : fallback;
}

export function planTarget(platform: Platform, argument: string, home: string, root: string, dir: string): string {
  const wanted = argument.trim();
  const expanded = expandTilde(platform, wanted, home);
  if (expanded !== wanted) return expanded ?? wanted;
  if (isAbsolutePath(platform, wanted)) return wanted;
  if (toPosix(platform, wanted).includes("/")) return joinPath(platform, root, wanted);
  return joinPath(platform, dir, wanted.endsWith(".md") ? wanted : `${wanted}.md`);
}

export function recentPlans(
  entries: readonly { name: string; kind: string; mtimeMs: number }[],
  dir: string,
  limit = RECENT_PLANS,
): PlanFile[] {
  return entries
    .filter((entry) => entry.kind === "file" && entry.name.endsWith(".md"))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((entry) => ({ name: entry.name.slice(0, -3), path: `${dir}/${entry.name}`, mtimeMs: entry.mtimeMs }));
}
