import type { Level } from "./ui-kit.ts";

export type Fix = "remove-setup-block" | "add-refresh-interval";
export type Check = { id: string; label: string; level: Level; detail: string; fix?: Fix };

export type Env = Readonly<{
  CLAUDE_CODE_SUBAGENT_MODEL_FORCE?: string | undefined;
  CLAUDE_CODE_DISABLE_ADVISOR_TOOL?: string | undefined;
  DISABLE_TELEMETRY?: string | undefined;
  DO_NOT_TRACK?: string | undefined;
  DISABLE_GROWTHBOOK?: string | undefined;
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC?: string | undefined;
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
  env: Env;
  userSettings: string | null;
  claudeMd: { path: string; text: string | null };
};

export const ENGINE_FLOOR = "2.1.287";
export const BUN_FLOOR = "1.4.2";
const FRESH_MS = 10 * 60_000;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const OPEN = /^--- omca-setup\s*$/;
const CLOSE = /^--- \/omca-setup ---\s*$/;

type Version = readonly [number, number, number];

function parseVersion(text: string): Version | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isOlder(version: Version, floor: string): boolean {
  const [a, b, c] = parseVersion(floor) ?? [0, 0, 0];
  return version[0] !== a ? version[0] < a : version[1] !== b ? version[1] < b : version[2] < c;
}

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const isOn = (value: string | undefined) => value !== undefined && !/^(|0|false|no|off)$/i.test(value.trim());

const check = (id: string, label: string, level: Level, detail: string, fix?: Fix): Check =>
  fix === undefined ? { id, label, level, detail } : { id, label, level, detail, fix };

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
    return check("bun", "bun", "fail", "bun is not on this session's PATH, and the omca server runs on bun");
  }
  const version = parseVersion(text);
  if (version === undefined) return check("bun", "bun", "warn", `bun --version printed "${text}", not a version`);
  if (isOlder(version, BUN_FLOOR)) {
    return check("bun", "bun", "fail", `bun ${text} is older than ${BUN_FLOOR}, which the omca server needs`);
  }
  return check(
    "bun",
    "bun",
    "ok",
    `bun ${text} is on PATH; Desktop and VS Code start .mcp.json with the GUI's PATH, which can lack ~/.bun/bin`,
  );
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
      return check("server", "omca server", "warn", `Could not read the session status file: ${hook.reason}`);
    case "missing":
      return check("server", "omca server", "warn", "No hook has reached the server in this session yet");
    case "seen": {
      const age = now - hook.lastHookAt * 1000;
      return age <= FRESH_MS
        ? check("server", "omca server", "ok", `Last hook call ${ago(age)}`)
        : check("server", "omca server", "warn", `Last hook call ${ago(age)}; hooks may have stopped reaching it`);
    }
  }
}

function astGrepCheck(found: Inputs["astGrep"]): Check {
  return found === null
    ? check("ast-grep", "ast-grep", "warn", "Neither ast-grep nor sg is on PATH, so the five ast tools return an error")
    : check("ast-grep", "ast-grep", "ok", `${found.name} ${found.version} is on PATH`);
}

function optionsCheck(settings: Inputs["settings"]): Check {
  const configs = record(settings["pluginConfigs"]) ?? {};
  const key = Object.keys(configs).find((name) => name.startsWith("oh-my-claudeagent@"));
  if (key === undefined) {
    return check("options", "Options", "info", "No pluginConfigs entry, so the defaults apply: showBand on, guardMode dialog");
  }
  const options = record(record(configs[key])?.["options"]) ?? {};
  const { showBand = true, guardMode = "dialog" } = options;
  if (typeof showBand !== "boolean") {
    return check("options", "Options", "warn", `showBand ${JSON.stringify(showBand)} is not true or false; on applies`);
  }
  if (guardMode !== "dialog" && guardMode !== "deny") {
    return check("options", "Options", "warn", `guardMode ${JSON.stringify(guardMode)} is not dialog or deny; dialog applies`);
  }
  return check("options", "Options", "ok", `showBand ${showBand ? "on" : "off"}, guardMode ${guardMode}, from ${key}`);
}

function modelForceCheck(env: Env): Check {
  return isOn(env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE)
    ? check("model-force", "Agent models", "warn", "CLAUDE_CODE_SUBAGENT_MODEL_FORCE puts every agent on one model, oracle included")
    : check("model-force", "Agent models", "ok", "Each agent keeps the model tier it declares");
}

function effortCheck(cap: unknown): Check {
  if (cap === undefined) return check("effort", "Effort cap", "ok", "No maxEffortLevel, so agents run at the effort they declare");
  const rank = typeof cap === "string" ? EFFORTS.indexOf(cap) : -1;
  if (rank < 0) return check("effort", "Effort cap", "warn", `maxEffortLevel ${JSON.stringify(cap)} is not a known level`);
  if (rank >= EFFORTS.indexOf("xhigh")) {
    return check("effort", "Effort cap", "ok", `maxEffortLevel ${cap} leaves every declared effort in place`);
  }
  return rank === EFFORTS.indexOf("high")
    ? check("effort", "Effort cap", "warn", "maxEffortLevel high holds oracle below the xhigh it declares")
    : check("effort", "Effort cap", "warn", `maxEffortLevel ${cap} holds every agent below the effort it declares`);
}

function modsCheck(settings: Inputs["settings"]): Check {
  const guard = record(record(record(settings["pluginConfigs"])?.["cc-plugin-sec-default@builtin"])?.["options"]);
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

function advisorCheck(settings: Inputs["settings"], env: Env): Check {
  const blockers: readonly (readonly [string, boolean])[] = [
    ["CLAUDE_CODE_DISABLE_ADVISOR_TOOL", isOn(env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL)],
    ["DISABLE_TELEMETRY", env.DISABLE_TELEMETRY !== undefined],
    ["DO_NOT_TRACK", env.DO_NOT_TRACK?.trim() === "1"],
    ["DISABLE_GROWTHBOOK", isOn(env.DISABLE_GROWTHBOOK)],
    ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", isOn(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)],
  ];
  const blocker = blockers.find(([, isSet]) => isSet)?.[0];
  if (blocker !== undefined) {
    return check("advisor", "Advisor", "warn", `${blocker} keeps the advisor off, so OMCA consults oracle instead`);
  }
  const model = settings["advisorModel"];
  return typeof model === "string" && model !== ""
    ? check("advisor", "Advisor", "ok", `advisorModel ${model}, and nothing here keeps it off`)
    : check("advisor", "Advisor", "info", "No advisorModel; /advisor fable turns the advisor on");
}

function statusLineCheck(settings: Inputs["settings"], userSettings: string | null): Check {
  const statusLine = record(settings["statusLine"]);
  if (statusLine === undefined) return check("statusline", "Status line", "info", "No statusLine is set");
  const interval = statusLine["refreshInterval"];
  if (typeof interval === "number" && interval >= 1) {
    return check("statusline", "Status line", "ok", `Refreshes every ${interval} s as well as on events`);
  }
  if (interval !== undefined) {
    return check("statusline", "Status line", "warn", `refreshInterval ${JSON.stringify(interval)} is not a number of seconds of at least 1`);
  }
  const user = userSettings === null ? undefined : parseObject(userSettings);
  const isUsers = JSON.stringify(user?.["statusLine"]) === JSON.stringify(statusLine);
  const isFixable = isUsers && userSettings !== null && addRefreshInterval(userSettings) !== undefined;
  return check(
    "statusline",
    "Status line",
    "warn",
    "No refreshInterval, so it redraws on events only and goes stale while agents run",
    isFixable ? "add-refresh-interval" : undefined,
  );
}

function setupBlockCheck({ path, text }: Inputs["claudeMd"]): Check {
  const block = text === null ? null : setupBlock(text);
  if (block === null) return check("setup-block", "CLAUDE.md", "ok", `No omca-setup block in ${path}`);
  if (block === "unclosed") {
    return check("setup-block", "CLAUDE.md", "warn", `${path} opens an omca-setup block that never closes; remove it by hand`);
  }
  return check(
    "setup-block",
    "CLAUDE.md",
    "warn",
    `${path} holds the 2.x omca-setup block, which v3 replaces by delivering that guidance itself`,
    "remove-setup-block",
  );
}

export function doctorChecks(inputs: Inputs): Check[] {
  return [
    modCheck(inputs.modVersion),
    engineCheck(inputs.engineVersion),
    bunCheck(inputs.bunVersion),
    hookCheck(inputs.hook, inputs.now),
    astGrepCheck(inputs.astGrep),
    optionsCheck(inputs.settings),
    modelForceCheck(inputs.env),
    effortCheck(inputs.settings["maxEffortLevel"]),
    modsCheck(inputs.settings),
    hooksCheck(inputs.settings),
    advisorCheck(inputs.settings, inputs.env),
    statusLineCheck(inputs.settings, inputs.userSettings),
    setupBlockCheck(inputs.claudeMd),
  ];
}

function parseObject(text: string): Readonly<Record<string, unknown>> | undefined {
  try {
    return record(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** The block's span from its opening marker's first character to past its closing marker's line end. */
export function setupBlock(text: string): { from: number; to: number } | "unclosed" | null {
  let at = 0;
  let from: number | undefined;
  for (const line of text.split("\n")) {
    const end = at + line.length + 1;
    if (from === undefined && OPEN.test(line)) from = at;
    else if (from !== undefined && CLOSE.test(line)) return { from, to: Math.min(end, text.length) };
    at = end;
  }
  return from === undefined ? null : "unclosed";
}

export function removeSetupBlock(text: string): string | undefined {
  const block = setupBlock(text);
  return block === null || block === "unclosed" ? undefined : text.slice(0, block.from) + text.slice(block.to);
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
  const statusLine = record(before?.["statusLine"]);
  if (before === undefined || statusLine === undefined || "refreshInterval" in statusLine) return undefined;
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
