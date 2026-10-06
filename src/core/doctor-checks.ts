import { RENAMES } from "./agent-names.ts";
import { EFFORTS } from "./route-hint.ts";
import { isRecord } from "./tool-input.ts";
import { isGlyphTier } from "./ui-kit.ts";
import type { Level } from "./visual.ts";

export type Fix = "add-refresh-interval";
/** `prompt` is a command the person can run to fix the check; the Doctor tab fills the prompt with it and never submits. */
export type Check = { id: string; label: string; level: Level; detail: string; fix?: Fix; prompt?: string };

export const SETUP_COMMAND = "/oh-my-claudeagent:omca-setup";
export const MIGRATE_COMMAND = `${SETUP_COMMAND} --migrate`;

type DoctorEnv = Readonly<{
  CLAUDE_CODE_SUBAGENT_MODEL_FORCE?: string | undefined;
  CLAUDE_CODE_DISABLE_ADVISOR_TOOL?: string | undefined;
  DISABLE_TELEMETRY?: string | undefined;
  DO_NOT_TRACK?: string | undefined;
  DISABLE_GROWTHBOOK?: string | undefined;
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC?: string | undefined;
  OMCA_GLYPHS?: string | undefined;
}>;

export type HookState =
  | { kind: "seen"; lastHookAt: number }
  | { kind: "missing" }
  | { kind: "unsafe-id" }
  | { kind: "unreadable"; reason: string };

export type Inputs = {
  modVersion: string | null;
  engineVersion: string;
  bunVersion: string | null;
  astGrep: { name: string; version: string } | null;
  hook: HookState;
  now: number;
  settings: Readonly<Record<string, unknown>>;
  options: { showBand: boolean; guardMode: "dialog" | "deny" };
  env: DoctorEnv;
  userSettings: string | null;
  isStyleForced: boolean | null;
  hasOldMemory: boolean;
};

const ENGINE_FLOOR = "2.1.288";
export const BUN_FLOOR = "1.4.2";
const FRESH_MS = 10 * 60_000;

type Version = readonly [number, number, number];

function parseVersion(text: string): Version | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isOlder(version: Version, floor: string): boolean {
  const [a, b, c] = parseVersion(floor) ?? [0, 0, 0];
  return version[0] !== a ? version[0] < a : version[1] !== b ? version[1] < b : version[2] < c;
}

function pluginOptions(settings: Inputs["settings"], plugin: string): Readonly<Record<string, unknown>> | undefined {
  const configs = settings["pluginConfigs"];
  const config = isRecord(configs) ? configs[plugin] : undefined;
  const options = isRecord(config) ? config["options"] : undefined;
  return isRecord(options) ? options : undefined;
}

const isOn = (value: string | undefined) => value !== undefined && !/^(|0|false|no|off)$/i.test(value.trim());

const check = (id: string, label: string, level: Level, detail: string, act: { fix?: Fix | undefined; prompt?: string } = {}): Check => ({
  id,
  label,
  level,
  detail,
  ...(act.fix === undefined ? {} : { fix: act.fix }),
  ...(act.prompt === undefined ? {} : { prompt: act.prompt }),
});

const MCP = { prompt: "/mcp" };

function modCheck(version: string | null): Check {
  return version === null
    ? check("mod", "OMCA", "warn", "Could not read this mod's version from its manifest")
    : check("mod", "OMCA", "ok", `oh-my-claudeagent ${version} is loaded`);
}

function engineCheck(text: string): Check {
  const version = parseVersion(text);
  if (version === undefined) return check("engine", "Claude Code", "warn", `Could not read a version from "${text}"`);
  return isOlder(version, ENGINE_FLOOR)
    ? check("engine", "Claude Code", "fail", `${text} is older than ${ENGINE_FLOOR}, which the OMCA mod needs`)
    : check("engine", "Claude Code", "ok", `${text} meets the ${ENGINE_FLOOR} floor`);
}

function bunCheck(text: string | null): Check {
  if (text === null) {
    return check(
      "bun",
      "bun",
      "fail",
      "bun is not on this session's PATH, and the omca server runs on bun; Desktop and VS Code start .mcp.json with the GUI's PATH, which can lack ~/.bun/bin",
    );
  }
  const version = parseVersion(text);
  if (version === undefined) return check("bun", "bun", "warn", `bun --version printed "${text}", not a version`);
  if (isOlder(version, BUN_FLOOR)) {
    return check("bun", "bun", "fail", `bun ${text} is older than ${BUN_FLOOR}, which the omca server needs`);
  }
  return check("bun", "bun", "ok", `bun ${text} is on PATH`);
}

function ago(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  return minutes === 0 ? "under a minute ago" : `${minutes} min ago`;
}

function hookCheck(hook: HookState, now: number): Check {
  switch (hook.kind) {
    case "unsafe-id":
      return check("server", "omca server", "warn", "The session id cannot name a status file, so it was not read");
    case "unreadable":
      return check("server", "omca server", "warn", `Could not read the session status file: ${hook.reason}`, MCP);
    case "missing":
      return check("server", "omca server", "warn", "No hook has reached the server in this session yet", MCP);
    case "seen": {
      const age = now - hook.lastHookAt * 1000;
      return age <= FRESH_MS
        ? check("server", "omca server", "ok", `Last hook call ${ago(age)}`)
        : check("server", "omca server", "warn", `Last hook call ${ago(age)}; hooks may have stopped reaching it`, MCP);
    }
  }
}

function astGrepCheck(found: Inputs["astGrep"]): Check {
  return found === null
    ? check("ast-grep", "ast-grep", "warn", "Neither ast-grep nor sg is on PATH, so the five ast tools return an error")
    : check("ast-grep", "ast-grep", "ok", `${found.name} ${found.version} is on PATH`);
}

function optionsCheck({ showBand, guardMode }: Inputs["options"]): Check {
  return check("options", "Options", "ok", `showBand ${showBand ? "on" : "off"}, guardMode ${guardMode}`);
}

function modelForceCheck(env: DoctorEnv): Check {
  return isOn(env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE)
    ? check("model-force", "Agent models", "warn", "CLAUDE_CODE_SUBAGENT_MODEL_FORCE puts every agent on one model, the architect included")
    : check("model-force", "Agent models", "ok", "Each agent keeps the model tier it declares");
}

// Only a value that names no tier is worth a row: unset or valid, the drawing itself shows the glyphs.
function glyphsCheck(env: DoctorEnv): Check[] {
  const value = env.OMCA_GLYPHS?.trim().toLowerCase() ?? "";
  if (value === "" || isGlyphTier(value)) return [];
  return [check("glyphs", "Glyphs", "warn", `OMCA_GLYPHS=${JSON.stringify(env.OMCA_GLYPHS)} is not nerd, unicode or ascii, so Nerd Font glyphs draw`)];
}

const LEVELS: readonly string[] = EFFORTS;

function effortCheck(cap: unknown): Check {
  if (cap === undefined) return check("effort", "Effort cap", "ok", "No maxEffortLevel, so agents run at the effort they declare");
  const rank = typeof cap === "string" ? LEVELS.indexOf(cap) : -1;
  if (rank < 0) return check("effort", "Effort cap", "warn", `maxEffortLevel ${JSON.stringify(cap)} is not a known level`);
  if (rank >= LEVELS.indexOf("xhigh")) {
    return check("effort", "Effort cap", "ok", `maxEffortLevel ${cap} leaves every declared effort in place`);
  }
  return rank === LEVELS.indexOf("high")
    ? check("effort", "Effort cap", "warn", "maxEffortLevel high holds the architect below the xhigh it declares")
    : check("effort", "Effort cap", "warn", `maxEffortLevel ${cap} holds every agent below the effort it declares`);
}

function modsCheck(settings: Inputs["settings"]): Check {
  const guard = pluginOptions(settings, "cc-plugin-sec-default@builtin");
  return settings["allowManagedModsOnly"] === true || guard?.["allowManagedModsOnly"] === true
    ? check("mods", "Mod policy", "warn", "allowManagedModsOnly loads OMCA's mod only if your organization installed it")
    : check("mods", "Mod policy", "ok", "Mods you install may load");
}

function hooksCheck(settings: Inputs["settings"]): Check {
  if (settings["disableAllHooks"] === true) {
    return check("hooks", "Hooks", "fail", "disableAllHooks is on, so OMCA's gates and guidance never run");
  }
  if (settings["allowManagedHooksOnly"] === true) {
    return check("hooks", "Hooks", "fail", "allowManagedHooksOnly blocks OMCA's hooks unless your organization installed it");
  }
  return check("hooks", "Hooks", "ok", "Neither disableAllHooks nor allowManagedHooksOnly is set");
}

const isOmcaStyle = (style: string) => style.slice(style.indexOf(":") + 1).trim() === "OMCA Default";

function outputStyleCheck(settings: Inputs["settings"], isForced: boolean | null): Check {
  const configured = settings["outputStyle"];
  const active = typeof configured === "string" && configured !== "" ? configured : "default";
  const options = pluginOptions(settings, "oh-my-claudeagent@omca");
  if (isForced === true) return check("style", "Output style", "ok", "OMCA Default is forced by the plugin");
  if (options?.["disableForceOrchestrationStyle"] === true) {
    return check("style", "Output style", "ok", `disableForceOrchestrationStyle is on, so your outputStyle ${active} applies`);
  }
  if (isOmcaStyle(active)) return check("style", "Output style", "ok", "OMCA Default is the selected output style");
  if (isForced === null) {
    return check("style", "Output style", "warn", `Could not read the plugin's output style file, so whether OMCA Default is forced is unknown; outputStyle is ${active}`);
  }
  return check(
    "style",
    "Output style",
    "warn",
    `${active} is the active output style and OMCA Default is not forced; update or reinstall the plugin to restore its force-for-plugin line, or choose OMCA Default in /config`,
    { prompt: "/config" },
  );
}

function advisorCheck(settings: Inputs["settings"], env: DoctorEnv): Check {
  const blockers: readonly (readonly [string, boolean])[] = [
    ["CLAUDE_CODE_DISABLE_ADVISOR_TOOL", isOn(env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL)],
    ["DISABLE_TELEMETRY", env.DISABLE_TELEMETRY !== undefined],
    ["DO_NOT_TRACK", env.DO_NOT_TRACK?.trim() === "1"],
    ["DISABLE_GROWTHBOOK", isOn(env.DISABLE_GROWTHBOOK)],
    ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", isOn(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)],
  ];
  const blocker = blockers.find(([, isSet]) => isSet)?.[0];
  if (blocker !== undefined) {
    return check("advisor", "Advisor", "warn", `${blocker} keeps the advisor off, so OMCA consults the architect instead`);
  }
  const model = settings["advisorModel"];
  return typeof model === "string" && model !== ""
    ? check("advisor", "Advisor", "ok", `advisorModel ${model}, and nothing here keeps it off`)
    : check("advisor", "Advisor", "info", "No advisorModel; /advisor fable turns the advisor on", { prompt: "/advisor fable" });
}

function statusLineCheck(settings: Inputs["settings"], userSettings: string | null): Check {
  const statusLine = settings["statusLine"];
  if (!isRecord(statusLine)) {
    return check("statusline", "Status line", "info", "No statusLine is set", { prompt: SETUP_COMMAND });
  }
  const interval = statusLine["refreshInterval"];
  if (typeof interval === "number" && interval >= 1) {
    return check("statusline", "Status line", "ok", `Refreshes every ${interval} s as well as on events`);
  }
  if (interval !== undefined) {
    return check("statusline", "Status line", "warn", `refreshInterval ${JSON.stringify(interval)} is not a number of seconds of at least 1`, {
      prompt: SETUP_COMMAND,
    });
  }
  const user = userSettings === null ? undefined : parseObject(userSettings);
  const isUsers = JSON.stringify(user?.["statusLine"]) === JSON.stringify(statusLine);
  const isFixable = isUsers && userSettings !== null && addRefreshInterval(userSettings) !== undefined;
  return check(
    "statusline",
    "Status line",
    "warn",
    "No refreshInterval, so it redraws on events only and goes stale while agents run",
    isFixable ? { fix: "add-refresh-interval" } : { prompt: SETUP_COMMAND },
  );
}

const OLD_AGENTS = Object.keys(RENAMES.agents).join("|");
const OLD_AGENT_ID = new RegExp(`oh-my-claudeagent:(?:${OLD_AGENTS})(?![\\w-])`);

// Only a setup that still carries an old name is worth a row: otherwise the migration has nothing to do.
function migrationCheck({ hasOldMemory, settings }: Inputs): Check[] {
  if (!hasOldMemory && !OLD_AGENT_ID.test(JSON.stringify(settings))) return [];
  return [
    check("migrate", "Agent names", "warn", `Agent memories or settings use agent names from the rename table; run ${MIGRATE_COMMAND}`, {
      prompt: MIGRATE_COMMAND,
    }),
  ];
}

export function doctorChecks(inputs: Inputs): Check[] {
  return [
    modCheck(inputs.modVersion),
    engineCheck(inputs.engineVersion),
    bunCheck(inputs.bunVersion),
    hookCheck(inputs.hook, inputs.now),
    astGrepCheck(inputs.astGrep),
    optionsCheck(inputs.options),
    modelForceCheck(inputs.env),
    ...glyphsCheck(inputs.env),
    effortCheck(inputs.settings["maxEffortLevel"]),
    modsCheck(inputs.settings),
    hooksCheck(inputs.settings),
    outputStyleCheck(inputs.settings, inputs.isStyleForced),
    advisorCheck(inputs.settings, inputs.env),
    statusLineCheck(inputs.settings, inputs.userSettings),
    ...migrationCheck(inputs),
  ];
}

const BYTE_ORDER_MARK = 0xfeff;

function parseObject(text: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed: unknown = JSON.parse(text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stringEnd(text: string, quote: number): number {
  for (let at = quote + 1; at < text.length; at += 1) {
    if (text[at] === "\\") at += 1;
    else if (text[at] === '"') return at + 1;
  }
  return text.length;
}

function closing(text: string, open: number): number {
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    const char = text[at];
    if (char === '"') at = stringEnd(text, at) - 1;
    else if (char === "{" || char === "[") depth += 1;
    else if ((char === "}" || char === "]") && --depth === 0) return at;
  }
  return -1;
}

const skipSpace = (text: string, at: number) => at + (/^\s*/.exec(text.slice(at))?.[0].length ?? 0);

function statusLineSpan(text: string): { open: number; close: number } | undefined {
  let depth = 0;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === '"') {
      const end = stringEnd(text, at);
      const colon = skipSpace(text, end);
      if (depth === 1 && text.slice(at, end) === '"statusLine"' && text[colon] === ":") {
        const open = skipSpace(text, colon + 1);
        return text[open] === "{" ? { open, close: closing(text, open) } : undefined;
      }
      at = end - 1;
    } else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth -= 1;
  }
  return undefined;
}

// Inserts the member after the object's last one, on its own line at the first member's indent
// when the object spans lines, so every byte outside the insertion stays as it was.
export function addRefreshInterval(text: string): string | undefined {
  const before = parseObject(text);
  const statusLine = before?.["statusLine"];
  if (before === undefined || !isRecord(statusLine) || "refreshInterval" in statusLine) return undefined;
  const span = statusLineSpan(text);
  if (span === undefined || span.close < 0) return undefined;
  let last = span.close - 1;
  while (/\s/.test(text[last] ?? "")) last -= 1;
  const lead = /^\s*/.exec(text.slice(span.open + 1))?.[0] ?? "";
  const newline = lead.lastIndexOf("\n");
  const member = '"refreshInterval": 5';
  const piece =
    last === span.open
      ? member
      : newline < 0
        ? `, ${member}`
        : `,${lead[newline - 1] === "\r" ? "\r\n" : "\n"}${lead.slice(newline + 1)}${member}`;
  const after = text.slice(0, last + 1) + piece + text.slice(last + 1);
  const expected = { ...before, statusLine: { ...statusLine, refreshInterval: 5 } };
  return JSON.stringify(parseObject(after)) === JSON.stringify(expected) ? after : undefined;
}

const linesOf = (text: string) => {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

const range = (start: number, count: number) =>
  count === 0 ? `${start},0` : count === 1 ? `${start + 1}` : `${start + 1},${count}`;

/** One hunk around the single changed region, with three lines of context. */
export function unifiedDiff(fromLabel: string, toLabel: string, before: string, after: string): string {
  const a = linesOf(before);
  const b = linesOf(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const start = Math.max(0, head - 3);
  const trailing = Math.min(3, tail);
  const aEnd = a.length - tail;
  const bEnd = b.length - tail;
  return [
    `--- ${fromLabel}`,
    `+++ ${toLabel}`,
    `@@ -${range(start, aEnd + trailing - start)} +${range(start, bEnd + trailing - start)} @@`,
    ...a.slice(start, head).map((line) => ` ${line}`),
    ...a.slice(head, aEnd).map((line) => `-${line}`),
    ...b.slice(head, bEnd).map((line) => `+${line}`),
    ...a.slice(aEnd, aEnd + trailing).map((line) => ` ${line}`),
  ].join("\n");
}
