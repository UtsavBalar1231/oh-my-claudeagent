import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { unifiedDiff } from "../src/core/doctor-checks.ts";
import { configDir, toPlatform, toPosix } from "../src/core/path.ts";

type Member = { key: string; start: number; valueStart: number; end: number };

const USAGE = "usage: bun scripts/setup-statusline.ts --settings <path> [--yes] [--uninstall]";
const LAUNCHER_SOURCE = join(import.meta.dir, "..", "statusline", "launcher.ts");

function fail(message: string, code = 1): never {
  console.error(`omca setup: ${message}`);
  process.exit(code);
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const skipSpace = (text: string, at: number): number => at + (/^\s*/.exec(text.slice(at))?.[0].length ?? 0);

function stringEnd(text: string, quote: number): number {
  for (let at = quote + 1; at < text.length; at += 1) {
    if (text[at] === "\\") at += 1;
    else if (text[at] === '"') return at + 1;
  }
  return text.length;
}

function valueEnd(text: string, start: number): number {
  if (text[start] === '"') return stringEnd(text, start);
  if (text[start] !== "{" && text[start] !== "[") return start + (/^[^\s,\]}]*/.exec(text.slice(start))?.[0].length ?? 0);
  let depth = 0;
  for (let at = start; at < text.length; at += 1) {
    const char = text[at];
    if (char === '"') at = stringEnd(text, at) - 1;
    else if (char === "{" || char === "[") depth += 1;
    else if ((char === "}" || char === "]") && --depth === 0) return at + 1;
  }
  return text.length;
}

// Only called on text JSON.parse accepted as an object, so the root members can be walked in order.
function rootMembers(text: string): { open: number; close: number; list: Member[] } {
  const open = text.indexOf("{");
  const list: Member[] = [];
  let at = skipSpace(text, open + 1);
  while (text[at] === '"') {
    const keyEnd = stringEnd(text, at);
    const valueStart = skipSpace(text, skipSpace(text, keyEnd) + 1);
    const end = valueEnd(text, valueStart);
    list.push({ key: JSON.parse(text.slice(at, keyEnd)), start: at, valueStart, end });
    at = skipSpace(text, end);
    if (text[at] === ",") at = skipSpace(text, at + 1);
  }
  return { open, close: at, list };
}

function setMember(text: string, key: string, value: unknown, sibling: string): string {
  const { open, close, list } = rootMembers(text);
  const lead = list[0] === undefined ? "" : text.slice(open + 1, list[0].start);
  const indent = lead.includes("\n") ? lead.slice(lead.lastIndexOf("\n") + 1) : "  ";
  const json = JSON.stringify(value, null, indent).replaceAll("\n", `\n${indent}`);
  const existing = list.findLast((member) => member.key === key);
  if (existing) return text.slice(0, existing.valueStart) + json + text.slice(existing.end);
  const member = `\n${indent}${JSON.stringify(key)}: ${json}`;
  const anchor = list.findLast((entry) => entry.key === sibling) ?? list.at(-1);
  if (anchor) return `${text.slice(0, anchor.end)},${member}${text.slice(anchor.end)}`;
  return `${text.slice(0, open + 1)}${member}\n${text.slice(close)}`;
}

function removeMember(text: string, key: string): string {
  const { open, close, list } = rootMembers(text);
  const index = list.findLastIndex((member) => member.key === key);
  const [previous, member, next] = [list[index - 1], list[index], list[index + 1]];
  if (member === undefined) return text;
  if (previous) return text.slice(0, previous.end) + text.slice(member.end);
  if (next) return text.slice(0, member.start) + text.slice(next.start);
  return text.slice(0, open + 1) + text.slice(close);
}

// An entry is ours when its command ends with our launcher and flags, however the program and
// the launcher are quoted or slashed; the program's path may hold spaces.
function isOurs(entry: unknown, suffix: string): boolean {
  if (typeof entry !== "object" || entry === null || !("command" in entry) || typeof entry.command !== "string") return false;
  return entry.command.replaceAll("\\", "/").replaceAll('"', "").endsWith(suffix);
}

let options: { settings?: string | undefined; yes: boolean; uninstall: boolean };
try {
  options = parseArgs({
    options: { settings: { type: "string" }, yes: { type: "boolean", default: false }, uninstall: { type: "boolean", default: false } },
  }).values;
} catch (error) {
  fail(`${reason(error)}\n${USAGE}`, 2);
}
const path = options.settings ?? fail(USAGE, 2);
const bun = Bun.which("bun") ?? fail("bun is not on PATH");
const launcher = join(configDir(process.env) ?? join(homedir(), ".claude"), "omca", "statusline.ts");
const platform = toPlatform(process.platform);
const launcherPath = toPosix(platform, launcher);
const bunArg = `"${toPosix(platform, bun)}"`;
const launcherArg = `"${launcherPath}"`;
const wanted = {
  statusLine: { type: "command", command: `${bunArg} ${launcherArg}`, padding: 1, refreshInterval: 5, hideVimModeIndicator: true },
  subagentStatusLine: { type: "command", command: `${bunArg} ${launcherArg} --subagent` },
};

const exists = existsSync(path);
const raw = exists ? readFileSync(path, "utf8") : "";
const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
const before = raw.slice(bom.length);
const base = exists ? before : "{}\n";
let settings: unknown;
try {
  settings = JSON.parse(base);
} catch (error) {
  fail(`${path} is not valid JSON (${reason(error)}); nothing was written`);
}
if (typeof settings !== "object" || settings === null || Array.isArray(settings)) fail(`${path} does not hold a JSON object; nothing was written`);

const current: Record<string, unknown> = { ...settings };
const expected: Record<string, unknown> = { ...settings };
let after = base;
for (const [key, value] of Object.entries(wanted)) {
  const sibling = key === "statusLine" ? "subagentStatusLine" : "statusLine";
  if (options.uninstall && isOurs(current[key], key === "statusLine" ? launcherPath : `${launcherPath} --subagent`)) {
    after = removeMember(after, key);
    delete expected[key];
  } else if (!options.uninstall && !Bun.deepEquals(current[key], value, true)) {
    after = setMember(after, key, value, sibling);
    expected[key] = value;
  }
}
if (!Bun.deepEquals(JSON.parse(after), expected, true)) fail(`could not edit ${path} without touching its other keys; nothing was written`);

const launcherInstalled = existsSync(launcher);
const launcherChanges = options.uninstall ? launcherInstalled : !launcherInstalled || readFileSync(launcher, "utf8") !== readFileSync(LAUNCHER_SOURCE, "utf8");
if (after === base && !launcherChanges) {
  console.log(options.uninstall ? `Nothing to remove: no OMCA status line in ${path} and no ${launcher}.` : `Already configured: ${path} runs both status lines through ${launcher}.`);
  process.exit(0);
}

if (after !== base) console.log(unifiedDiff(path, path, before, after));
if (launcherChanges) console.log(options.uninstall ? `remove ${launcher}` : `copy ${LAUNCHER_SOURCE} to ${launcher}`);

const confirmed = options.yes || (process.stdin.isTTY === true && /^y(es)?$/i.test(prompt("Apply this change? [y/N]")?.trim() ?? ""));
if (!confirmed) {
  console.log("Nothing was written. Run again with --yes to apply.");
  process.exit(0);
}

try {
  if (launcherChanges && !options.uninstall) {
    mkdirSync(dirname(launcher), { recursive: true });
    copyFileSync(LAUNCHER_SOURCE, launcher);
  }
  if (after !== base) {
    if (exists) writeFileSync(`${path}.omca-bak`, raw);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bom + after);
  }
  if (launcherChanges && options.uninstall) rmSync(launcher);
} catch (error) {
  fail(reason(error));
}
if (after !== base) console.log(exists ? `Wrote ${path}; the previous version is ${path}.omca-bak.` : `Wrote ${path}.`);
if (launcherChanges) console.log(options.uninstall ? `Removed ${launcher}.` : `Installed ${launcher}.`);
