import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Source = { path: string; text: string };

const REGISTER = "hooks/register.ts";
// The built-in sec-default guard continues these past user-tier mods wherever it loads.
const GUARDED = ["prompt.context", "prompt.section", "prompt.compose", "skill.prompt", "attribution.text", "settings.read"];
const ON = /(?<![\w$.])on\(\s*(["'`])([^"'`]+)\1\s*(?:,\s*(\{[^{}]*\}))?/g;

function reachesGuarded(pattern: string): boolean {
  if (pattern === "*" || pattern.startsWith("!") || pattern.startsWith("classic.")) return true;
  if (pattern.endsWith(".*")) return GUARDED.some((event) => event.startsWith(pattern.slice(0, -1)));
  return GUARDED.includes(pattern);
}

function violations(sources: readonly Source[]): string[] {
  const found: string[] = [];
  const registered = new Set<string>();
  for (const { path, text } of sources) {
    for (const match of text.matchAll(ON)) {
      const event = match[2] ?? "";
      const matcher = (match[3] ?? "").replace(/\s+/g, "").replaceAll("'", '"');
      const call = matcher === "" ? `on("${event}")` : `on("${event}", ${matcher})`;
      if (path !== REGISTER) found.push(`${path}: ${call} outside ${REGISTER}`);
      if (reachesGuarded(event)) found.push(`${path}: ${call} reaches an event the sec-default guard continues`);
      if (registered.has(call)) found.push(`${path}: ${call} registered twice`);
      registered.add(call);
    }
  }
  return found;
}

function hookSources(): Source[] {
  const root = join(import.meta.dir, "..");
  return readdirSync(join(root, "hooks"), { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => ({ path: `hooks/${name}`, text: readFileSync(join(root, "hooks", name), "utf8") }));
}

test("every hooks/**/*.ts registration is in register.ts, once per event and matcher, off the guard's list", () => {
  const sources = hookSources();
  expect(sources.map((source) => source.path)).toContain(REGISTER);
  expect(violations(sources)).toEqual([]);
});

test("the real register.ts is read: its two command.run matchers count as two registrations", () => {
  const register = hookSources().filter((source) => source.path === REGISTER);
  const calls = [...(register[0]?.text ?? "").matchAll(ON)].map((match) => `${match[2]} ${(match[3] ?? "").replace(/\s+/g, "")}`);
  expect(calls).toContain('command.run {command:"omca"}');
  expect(calls).toContain('command.run {command:"omca-rate"}');
});

test("a second registration of one event and matcher is flagged, a different matcher is not", () => {
  const text = [
    'on("command.run", { command: "omca" }, hook);',
    "on('command.run', {command:'omca'}, hook);",
    'on("command.run", { command: "omca-rate" }, hook);',
    'on("session.start", hook);',
  ].join("\n");
  expect(violations([{ path: REGISTER, text }])).toEqual([
    `${REGISTER}: on("command.run", {command:"omca"}) registered twice`,
  ]);
});

test("a registration outside register.ts is flagged, a method named on is not", () => {
  const sources = [
    { path: "hooks/band.ts", text: 'on("turn.complete", hook);\nemitter.on("x", f);\naddon("y");' },
    { path: REGISTER, text: 'on("turn.start", hook);' },
  ];
  expect(violations(sources)).toEqual([`hooks/band.ts: on("turn.complete") outside ${REGISTER}`]);
});

test("every event the guard continues, and every glob or negation that reaches one, is flagged", () => {
  const patterns = [
    "classic.PreToolUse",
    "classic.*",
    "prompt.context",
    "prompt.section",
    "prompt.compose",
    "skill.prompt",
    "attribution.text",
    "settings.read",
    "prompt.*",
    "*",
    "!tool.describe",
  ];
  const text = patterns.map((pattern) => `on("${pattern}", hook);`).join("\n");
  expect(violations([{ path: REGISTER, text }])).toEqual(
    patterns.map((pattern) => `${REGISTER}: on("${pattern}") reaches an event the sec-default guard continues`),
  );
});

test("guard-safe events and a settings read through the host are not flagged", () => {
  const text = [
    'on("tool.check", { tool: "Bash" }, hook);',
    'on("ui.*", hook);',
    'on("prompt.edit", hook);',
    "const settings = await host.settings.read();",
  ].join("\n");
  expect(violations([{ path: REGISTER, text }])).toEqual([]);
});
