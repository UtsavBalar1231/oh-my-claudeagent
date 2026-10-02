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
