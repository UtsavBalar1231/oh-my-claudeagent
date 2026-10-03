import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Check, type Context, exists, type Outcome, pass, verdict } from "./core.ts";

export const REGISTER = "hooks/register.ts";

// The built-in sec-default guard continues these past user-tier mods wherever it loads.
const GUARDED = ["prompt.context", "prompt.section", "prompt.compose", "skill.prompt", "attribution.text", "settings.read"];
const ON = /(?<![\w$.])on\(\s*(["'`])([^"'`]+)\1\s*(?:,\s*(\{[^{}]*\}))?/g;

export type Source = { path: string; text: string };
export type Registration = { path: string; event: string; matcher: string; call: string };

export function registrations(sources: readonly Source[]): Registration[] {
  return sources.flatMap(({ path, text }) =>
    [...text.matchAll(ON)].map((match) => {
      const event = match[2] ?? "";
      const matcher = (match[3] ?? "").replace(/\s+/g, "").replaceAll("'", '"');
      return { path, event, matcher, call: matcher === "" ? `on("${event}")` : `on("${event}", ${matcher})` };
    }),
  );
}

function reachesGuarded(pattern: string): boolean {
  if (pattern === "*" || pattern.startsWith("!") || pattern.startsWith("classic.")) return true;
  if (pattern.endsWith(".*")) return GUARDED.some((event) => event.startsWith(pattern.slice(0, -1)));
  return GUARDED.includes(pattern);
}

export function hookSources(ctx: Context): Source[] {
  const dir = join(ctx.root, "hooks");
  if (!exists(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((name) => name.replaceAll("\\", "/"))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".spec.ts"))
    .sort()
    .map((name) => ({ path: `hooks/${name}`, text: readFileSync(join(dir, name), "utf8") }));
}

export function guardedEvents(sources: readonly Source[]): Outcome {
  const found = registrations(sources);
  const problems = found.filter((r) => reachesGuarded(r.event)).map((r) => `${r.path}: ${r.call} reaches an event the sec-default guard continues`);
  return verdict(problems, `${found.length} registrations, none on an event the sec-default guard continues`);
}

export function onLocation(sources: readonly Source[]): Outcome {
  const problems = registrations(sources).filter((r) => r.path !== REGISTER).map((r) => `${r.path}: ${r.call} outside ${REGISTER}`);
  return verdict(problems, `every on() call is in ${REGISTER}`);
}

export function duplicateRegistration(sources: readonly Source[]): Outcome {
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const r of registrations(sources)) {
    if (seen.has(r.call)) problems.push(`${r.path}: ${r.call} registered twice`);
    seen.add(r.call);
  }
  return verdict(problems, `${seen.size} registrations, each event and matcher once`);
}

const mentions = (source: string, event: string): boolean => new RegExp(`["'\`]${event.replace(".", "\\.")}["'\`]`).test(source);

export function toolCheckAllow(sources: readonly Source[]): Outcome {
  const problems = sources
    .filter((s) => mentions(s.text, "tool.check") && /["'`]allow["'`]/.test(s.text))
    .map((s) => `${s.path}: names tool.check and an allow decision, and an allow there skips the auto-mode classifier`);
  return verdict(problems, "no file that handles tool.check names an allow decision");
}

export function compactMessages(sources: readonly Source[]): Outcome {
  const problems = sources
    .filter((s) => mentions(s.text, "session.compact") && /\bmessages\s*:|[{,]\s*messages\s*[,}]/.test(s.text))
    .map((s) => `${s.path}: session.compact answers with messages, which are lost on resume`);
  return verdict(problems, "no session.compact handler answers with messages");
}

function registerPresent(ctx: Context): Outcome {
  const source = hookSources(ctx).find((candidate) => candidate.path === REGISTER);
  if (source === undefined) return { status: "fail", detail: `${REGISTER} is missing` };
  const count = registrations([source]).length;
  return count === 0 ? { status: "fail", detail: `${REGISTER} registers no on() handler` } : pass(`${REGISTER} makes ${count} registrations`);
}

const onSources = (check: (sources: readonly Source[]) => Outcome) => (ctx: Context) => check(hookSources(ctx));

export const checks: readonly Check[] = [
  { name: "mod register.ts", run: registerPresent },
  { name: "mod guarded events", run: onSources(guardedEvents) },
  { name: "mod on() location", run: onSources(onLocation) },
  { name: "mod tool.check allow", run: onSources(toolCheckAllow) },
  { name: "mod session.compact messages", run: onSources(compactMessages) },
  { name: "mod duplicate registration", run: onSources(duplicateRegistration) },
];
