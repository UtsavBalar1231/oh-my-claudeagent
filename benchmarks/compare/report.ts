import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  blockedBy,
  type Breakdown,
  CATEGORIES,
  type Category,
  type FirstRunRecord,
  type GuardRecord,
  humanBytes,
  type InstallRecord,
  median,
  type NoBunRecord,
  pairedDiffs,
  type SnapChange,
  type SnapDiff,
  stats,
  type Stats,
  type StopRecord,
  type TimingRecord,
  tokens,
  type ToolSearchRecord,
  UNKNOWN_TYPE,
} from "./analyze.ts";
import { type Arm, type ArmsFile, SESSION_TIMEOUT_S } from "./harness.ts";
import { BASH_CALLS, KEYWORD_PROBE_PROMPT, KEYWORD_PROMPT, READ_CALLS } from "./scenarios.ts";

export type RawResults = {
  date: string;
  rounds: number;
  claudeVersions: string[];
  image: Record<string, string>;
  file: ArmsFile;
  treeShas: Record<string, string>;
  install: Record<string, InstallRecord>;
  firstRun: Record<string, FirstRunRecord>;
  timing: TimingRecord[];
  guards: GuardRecord[];
  stop: StopRecord[];
  toolSearch: ToolSearchRecord[];
  keywords: ToolSearchRecord[];
  noBun: NoBunRecord | null;
  configDirs: Record<string, string>;
};

const BASELINE = "baseline";
const OMCA = "omca";
const f0 = (n: number | null): string => (n === null ? "n/a" : Math.round(n).toLocaleString("en-US"));
const f1 = (n: number | null): string => (n === null ? "n/a" : n.toFixed(1));
const signed = (n: number | null, digits = 0): string => (n === null ? "n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`);
const signedK = (n: number | null): string => (n === null ? "n/a" : `${n >= 0 ? "+" : "-"}${f0(Math.abs(n))}`);
const list = (items: string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const code = (s: string): string => `\`${s}\``;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]): string => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

const spread = (s: Stats | null, digits = 0): string =>
  s === null ? "n/a" : `${s.median.toFixed(digits)} (${s.p25.toFixed(digits)}-${s.p75.toFixed(digits)}; p95 ${s.p95.toFixed(digits)}; n=${s.n})`;

type Section = { title: string; body: string };

function hooksJsonSummary(configDir: string): { events: Record<string, number>; handlers: number; types: Record<string, number> } {
  const events: Record<string, number> = {};
  const types: Record<string, number> = {};
  let handlers = 0;
  const root = join(configDir, "plugins", "cache");
  if (!existsSync(root)) return { events, handlers, types };
  for (const path of new Bun.Glob("**/hooks/hooks.json").scanSync({ cwd: root, absolute: true, dot: true })) {
    if (path.includes("/node_modules/")) continue;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { hooks?: Record<string, { hooks?: { type?: string }[] }[]> };
    for (const [event, groups] of Object.entries(parsed.hooks ?? {})) {
      for (const group of groups) {
        for (const hook of group.hooks ?? []) {
          events[event] = (events[event] ?? 0) + 1;
          types[hook.type ?? "command"] = (types[hook.type ?? "command"] ?? 0) + 1;
          handlers++;
        }
      }
    }
  }
  return { events, handlers, types };
}

type Details = { skills: number; agents: number; hooks: number; mcp: number; always_on_tokens: number };

function parseDetails(text: string): Details {
  const count = (label: string): number => Number(new RegExp(`${label} \\((\\d+)\\)`).exec(text)?.[1] ?? 0);
  const always = /Always-on:\s+~?([\d,]+|< ?\d+)/.exec(text)?.[1] ?? "0";
  return {
    skills: count("Skills"),
    agents: count("Agents"),
    hooks: count("Hooks"),
    mcp: count("MCP servers"),
    always_on_tokens: Number(always.replace(/[^\d]/g, "")),
  };
}

const sumDetails = (items: Details[]): Details =>
  items.reduce(
    (acc, d) => ({ skills: acc.skills + d.skills, agents: acc.agents + d.agents, hooks: acc.hooks + d.hooks, mcp: acc.mcp + d.mcp, always_on_tokens: acc.always_on_tokens + d.always_on_tokens }),
    { skills: 0, agents: 0, hooks: 0, mcp: 0, always_on_tokens: 0 },
  );

const normalize = (path: string): string =>
  path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
    .replace(/\d{9,}/g, "<n>")
    .replace(/\d{4}-\d{2}-\d{2}T[\d_.:-]+Z/g, "<ts>");

const GROUP_DEPTH = 4;
const groupPaths = (paths: string[]): string => {
  const groups = new Map<string, number>();
  for (const p of paths) {
    const key = normalize(p).split("/").slice(0, GROUP_DEPTH).join("/");
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups].map(([k, n]) => `${code(k)}${n > 1 ? ` x${n}` : ""}`).join(", ");
};

/** Counts files when the run recorded each entry's type, and every path otherwise, saying which. */
function countWrites(changes: SnapChange[], untyped: boolean): { count: number; label: string; groups: string; cell: string } {
  const paths = changes.filter((c) => untyped || c.type === "f").map((c) => c.path);
  const label = plural(paths.length, untyped ? "path" : "file");
  const groups = groupPaths(paths) || "none";
  return { count: paths.length, label, groups, cell: paths.length === 0 ? label : `${label}: ${groups}` };
}

const written = (diff: SnapDiff): SnapChange[] => [...diff.created, ...diff.modified];
const INSTRUCTION_FILE = /(^|\/)(CLAUDE\.md|settings(\.local)?\.json)$/;
const instructionFiles = (changes: SnapChange[]): string[] => changes.map((c) => c.path).filter((p) => INSTRUCTION_FILE.test(p));

// Another plugin arm counts as level with OMCA when the two are within this share of OMCA's value
// or within the metric's floor, whichever is wider.
const LEVEL_SHARE = 0.1;

type Standing = { own: number | null; lower: string[]; level: string[]; higher: string[] };

export function renderMarkdown(raw: RawResults): { results: Record<string, unknown>; markdown: string } {
  const { file } = raw;
  const arms: Arm[] = file.arms.filter((a) => a.id === BASELINE || raw.install[a.id] !== undefined);
  const plugins = arms.filter((a) => a.id !== BASELINE);
  const labelOf = (id: string): string => file.arms.find((a) => a.id === id)?.label ?? id;
  const timing = raw.timing.filter((r) => r.round >= 0);
  const runsOf = (arm: string, kind: string): TimingRecord[] =>
    timing.filter((r) => r.arm === arm && r.kind === kind).sort((x, y) => x.round - y.round);
  const okRuns = (arm: string, kind: string): TimingRecord[] => runsOf(arm, kind).filter((r) => r.rc === 0 && r.requests > 0);
  const numbers = (runs: TimingRecord[], pick: (r: TimingRecord) => number | null): number[] =>
    runs.map(pick).filter((v): v is number => v !== null);
  const pairedBy = (arm: string, kind: string, pick: (r: TimingRecord) => number | null): number[] => {
    const base = new Map(okRuns(BASELINE, kind).map((r) => [r.round, pick(r)]));
    return pairedDiffs(
      okRuns(arm, kind).map(pick),
      okRuns(arm, kind).map((r) => base.get(r.round) ?? null),
    );
  };
  const standing = (metric: (id: string) => number | null, floor: number): Standing => {
    const own = metric(OMCA);
    const others = plugins.filter((a) => a.id !== OMCA).flatMap((a) => {
      const value = metric(a.id);
      return value === null ? [] : [{ label: a.label, value }];
    });
    if (own === null) return { own, lower: [], level: [], higher: [] };
    const tolerance = Math.max(floor, Math.abs(own) * LEVEL_SHARE);
    return {
      own,
      lower: others.filter((o) => o.value < own - tolerance).map((o) => o.label),
      level: others.filter((o) => Math.abs(o.value - own) <= tolerance).map((o) => o.label),
      higher: others.filter((o) => o.value > own + tolerance).map((o) => o.label),
    };
  };
  const describe = (s: Standing, lowerWord: string, higherWord: string): string =>
    s.lower.length + s.level.length + s.higher.length === 0
      ? "no other plugin arm has a value"
      : [
      s.lower.length === 0 ? "" : `${lowerWord}: ${s.lower.join(", ")}`,
      s.level.length === 0 ? "" : `about level: ${s.level.join(", ")}`,
      s.higher.length === 0 ? "" : `${higherWord}: ${s.higher.join(", ")}`,
    ]
      .filter(Boolean)
      .join("; ");
  const isWorse = (s: Standing): boolean => s.lower.length > s.higher.length;

  const sections: Section[] = [];
  const results: Record<string, unknown> = {
    date: raw.date,
    claude: raw.claudeVersions,
    rounds: raw.rounds,
    token_estimator: "ceil(characters / 4); an estimate, applied identically to every arm",
  };

  const armRows = arms.map((arm) => {
    const record = raw.install[arm.id];
    const tree = arm.tree;
    const sha = raw.treeShas[arm.id] ?? (tree !== null && "sha" in tree ? tree.sha : "");
    const version = tree !== null && "version" in tree ? tree.version : "";
    const failed = record?.steps.find((s) => s.rc !== 0);
    return [
      arm.label,
      arm.id,
      version || "-",
      sha === "" ? "-" : code(sha.slice(0, 12)),
      arm.install.length === 0 ? "-" : arm.install.map(code).join(", "),
      arm.id === BASELINE ? "n/a" : record?.ok ? "installed" : `FAILED: ${failed?.error ?? "no install record"}`,
    ];
  });
  results.arms = armRows;
  sections.push({ title: "Arms and install outcome", body: table(["Arm", "id", "Version", "Commit", "Install ids", "Install outcome"], armRows) });

  const installOf = (id: string): InstallRecord | undefined => raw.install[id];
  const footprintRows = plugins.flatMap((arm) => {
    const r = installOf(arm.id);
    if (r === undefined) return [];
    const online = r.online;
    return [
      [
        arm.label,
        humanBytes(r.cache_bytes),
        f0(r.cache_files),
        `${f0(r.install_ms)} ms`,
        r.network.hosts.filter((h) => h !== "api.anthropic.com").join(", ") || "none",
        !online ? "n/a (no registry fetch attempted)" : `${humanBytes(online.cache_bytes)} / ${f0(online.cache_files)} files (${humanBytes(online.node_modules_bytes)} of node_modules) in ${f0(online.install_ms)} ms`,
      ],
    ];
  });
  const registryInstalls = plugins.filter((a) => installOf(a.id)?.network.hosts.includes("registry.npmjs.org") === true);
  results.footprint = Object.fromEntries(plugins.map((a) => [a.id, installOf(a.id)]));
  sections.push({
    title: "1. Install footprint",
    body: [
      table(
        ["Arm", "Plugin cache (offline install)", "Files", "Install time (offline)", "Hosts the install tried to reach", "Plugin cache after an online install probe"],
        footprintRows,
      ),
      "",
      "Offline install is the hermetic run (closed network, directory marketplace). The online probe repeats the install once on the default Docker bridge with no Anthropic credentials, only for arms whose offline install tried to reach the npm registry, to show what Claude Code would fetch. The host list comes from `strace -f -e trace=connect,sendto,sendmmsg,sendmsg` on every install step, with DNS names decoded from the query packets; `api.anthropic.com` appears for every arm, baseline included, and is filtered out.",
      ...(registryInstalls.length === 0
        ? []
        : [
            "",
            `Offline, ${list(registryInstalls.map((a) => `${a.label}'s install tried the npm registry and reported ${installOf(a.id)?.ok ? "success" : "failure"} after ${f0(installOf(a.id)?.install_ms ?? null)} ms`))}.`,
          ]),
    ].join("\n"),
  });

  const inventoryRows = arms.map((arm) => {
    const record = installOf(arm.id);
    if (arm.id === BASELINE || record === undefined) return [arm.label, "-", "-", "-", "-", "-", "-"];
    const total = sumDetails(Object.values(record.details).map(parseDetails));
    const hooks = hooksJsonSummary(raw.configDirs[arm.id] ?? "");
    const first = raw.firstRun[arm.id];
    const mods = first?.mods.map((m) => `${m.module.split("@")[0]} (${m.events.split(",").length} events)`).join(", ") ?? "";
    const mcpFirst = numbers(okRuns(arm.id, "a"), (r) => r.tools_mcp_n);
    return [
      arm.label,
      `${total.skills} / ${total.agents}`,
      `~${f0(total.always_on_tokens)}`,
      `${hooks.handlers} handlers over ${Object.keys(hooks.events).length} events`,
      mods === "" ? "-" : mods,
      first?.registered.replace(/^Registered /, "") ?? "n/a",
      mcpFirst.length === 0 ? "n/a" : `${f0(median(mcpFirst))} (min ${f0(Math.min(...mcpFirst))}, max ${f0(Math.max(...mcpFirst))})`,
    ];
  });
  const hookDetail = plugins.map((arm) => {
    const hooks = hooksJsonSummary(raw.configDirs[arm.id] ?? "");
    const events = Object.entries(hooks.events).map(([e, n]) => `${e} ${n}`).join(", ");
    const types = Object.entries(hooks.types).map(([t, n]) => `${t} ${n}`).join(", ");
    return `- ${arm.label}: ${events || "no hooks.json handlers"}${types === "" ? "" : ` (types: ${types})`}`;
  });
  results.inventory = Object.fromEntries(
    plugins.map((a) => [a.id, { details: installOf(a.id)?.details, hooks_json: hooksJsonSummary(raw.configDirs[a.id] ?? ""), mods: raw.firstRun[a.id]?.mods, registered: raw.firstRun[a.id]?.registered }]),
  );
  sections.push({
    title: "2. Inventory",
    body: [
      table(
        ["Arm", "Skills / agents (`plugin details`)", "Always-on tokens (`plugin details`)", "hooks.json", "Hook modules (mods)", "Hooks the client registered (debug log)", "MCP tools in the first request"],
        inventoryRows,
      ),
      "",
      "Hooks by event in each installed plugin's `hooks/hooks.json`:",
      "",
      ...hookDetail,
      "",
      "The always-on figure is Claude Code's own estimate of skill, agent and command names and descriptions (it does not count MCP schemas, output styles or hook output). The MCP tool count is the median of the `tools` array in the first request over all paired runs of session (a); a server that never connects contributes none.",
    ].join("\n"),
  });

  const medianChars = (breakdowns: Breakdown[]): Record<Category, number> | null =>
    breakdowns.length === 0 ? null : (Object.fromEntries(CATEGORIES.map((c) => [c, median(breakdowns.map((b) => b.chars[c] ?? 0)) ?? 0])) as Record<Category, number>);
  const breakdownOf = (arm: string, kind: string, which: "first" | "last"): Record<Category, number> | null =>
    medianChars(okRuns(arm, kind).map((r) => r[which]).filter((b): b is Breakdown => b !== null));
  const group = (chars: Record<Category, number>) => ({
    system: chars.system_prompt,
    builtin: chars.tools_builtin,
    mcp: chars.tools_mcp + chars.deferred_listing,
    listings: chars.agent_listing + chars.skill_listing,
    style: chars.output_style,
    mcpInstr: chars.mcp_instructions,
    hook: chars.hook_context,
    other: chars.environment + chars.context_reminder + chars.attribution + chars.other,
  });
  type Group = ReturnType<typeof group>;
  const totalOf = (chars: Record<Category, number>): number => Object.values(group(chars)).reduce((a, b) => a + b, 0);
  const tokenTable = (source: (armId: string) => Record<Category, number> | null) => {
    const base = source(BASELINE);
    const data: Record<string, Record<string, number>> = {};
    const deltas: Record<string, number> = {};
    const components: Record<string, Record<keyof Group, number>> = {};
    const rows = arms.flatMap((arm) => {
      const own = source(arm.id);
      if (own === null || base === null) return [];
      const g = group(own);
      const b = group(base);
      const delta = (k: keyof Group): number => tokens(g[k]) - tokens(b[k]);
      data[arm.id] = Object.fromEntries(CATEGORIES.map((c) => [c, tokens(own[c])]));
      deltas[arm.id] = tokens(totalOf(own)) - tokens(totalOf(base));
      components[arm.id] = { system: delta("system"), builtin: delta("builtin"), mcp: delta("mcp"), listings: delta("listings"), style: delta("style"), mcpInstr: delta("mcpInstr"), hook: delta("hook"), other: delta("other") };
      return [
        [
          arm.label,
          f0(tokens(g.system)),
          f0(tokens(g.builtin)),
          f0(tokens(g.mcp)),
          f0(tokens(g.listings)),
          f0(tokens(g.style)),
          f0(tokens(g.mcpInstr)),
          f0(tokens(g.hook)),
          f0(tokens(g.other)),
          f0(tokens(totalOf(own))),
          arm.id === BASELINE ? "-" : `**${signed(deltas[arm.id] ?? null)}**`,
          arm.id === BASELINE ? "-" : `sys ${signed(delta("system"))}, tools ${signed(delta("builtin") + delta("mcp"))}, lists ${signed(delta("listings"))}, style ${signed(delta("style"))}, mcp-instr ${signed(delta("mcpInstr"))}, hook ${signed(delta("hook"))}, other ${signed(delta("other"))}`,
        ],
      ];
    });
    return { rows, data, deltas, components };
  };
  const tokenHeader = ["Arm", "System prompt", "Tools built-in", "Tools MCP (or deferred names)", "Agent + skill listing", "Output style", "MCP instructions", "Hook context", "Env, git, attribution", "Total", "Delta vs baseline", "Delta by component"];
  const turn1 = tokenTable((id) => breakdownOf(id, "a", "first"));
  const turnN = tokenTable((id) => breakdownOf(id, "b", "last"));
  const searchRuns = (id: string): ToolSearchRecord[] => raw.toolSearch.filter((r) => r.arm === id && r.rc === 0 && r.first !== null);
  const searchBreakdowns = (id: string): Breakdown[] => searchRuns(id).flatMap((r) => (r.first === null ? [] : [r.first]));
  const turn1Search = tokenTable((id) => medianChars(searchBreakdowns(id)));
  const probeRounds = (records: ToolSearchRecord[]): number => new Set(records.map((r) => r.round)).size;
  results.tokens_turn1_tool_search = turn1Search.data;
  results.tokens_turn1 = turn1.data;
  results.tokens_turnN = turnN.data;

  const keywordBreakdowns = (id: string): Breakdown[] => raw.keywords.filter((r) => r.arm === id && r.rc === 0).flatMap((r) => (r.first === null ? [] : [r.first]));
  const keywordDelta = (id: string): number | null => {
    const a = breakdownOf(id, "a", "first");
    const k = medianChars(keywordBreakdowns(id));
    return a === null || k === null ? null : tokens(totalOf(k)) - tokens(totalOf(a));
  };
  const injectionRows = arms.flatMap((arm) => {
    const a = breakdownOf(arm.id, "a", "first");
    const d = breakdownOf(arm.id, "d", "first");
    const k = medianChars(keywordBreakdowns(arm.id));
    if (a === null || d === null) return [];
    return [
      [
        arm.label,
        f0(tokens(totalOf(a))),
        signed(tokens(totalOf(d)) - tokens(totalOf(a))),
        signed(keywordDelta(arm.id)),
        k === null ? "n/a" : signed(tokens(k.hook_context) - tokens(a.hook_context)),
      ],
    ];
  });
  const baselineKeyword = keywordDelta(BASELINE);
  results.prompt_injection = injectionRows;
  sections.push({
    title: "3. Tokens added per request (estimate)",
    body: [
      "Estimated tokens in the request body, excluding the user's prompt text. Method: every request body the mock received is split into the `system` array, the `tools` array (names starting `mcp__` are MCP, the rest built-in) and the message text blocks. Message text is cut at known section markers (`# Environment`, `Available agent types`, the skill listing line, `# Output Style:`, `# MCP Server Instructions`, `<event> hook additional context:`/`hook success:`). Tokens are `ceil(chars / 4)` for every arm, an estimate only: Claude's tokenizer is not available offline. Values are medians over the paired runs, and a delta is the difference of the two medians.",
      "",
      "**Turn 1** (first request of session (a), one plain prompt):",
      "",
      table(tokenHeader, turn1.rows),
      "",
      `**Turn 1 with tool search on** (\`ENABLE_TOOL_SEARCH=true\`, session (a), ${probeRounds(raw.toolSearch)} rounds). Claude Code turns tool search off when \`ANTHROPIC_BASE_URL\` is not a first-party host, which is the case in this harness, so the tables above ship every MCP tool schema in the \`tools\` array. Against the first-party API, MCP tools are deferred and only their names are listed (counted under Tools MCP here). This table is the closer match to real first-party traffic for MCP-heavy arms; tools that declare \`alwaysLoad\` stay loaded either way.`,
      "",
      table(tokenHeader, turn1Search.rows),
      "",
      `**Turn N** (the last main-thread request of session (b), after ${BASH_CALLS} Bash calls; the conversation itself, tool_use and tool_result text, is left out of every column and the total):`,
      "",
      table(tokenHeader, turnN.rows),
      "",
      `**Per-prompt injection**: session (d), prompt ${code(KEYWORD_PROMPT)}, against session (a), first request; and a keyword probe (${probeRounds(raw.keywords)} rounds) whose prompt is ${code(KEYWORD_PROBE_PROMPT)}, which carries the trigger words of several arms. Deltas are in estimated tokens with the prompt text itself excluded. Baseline has no plugin, so its keyword-probe delta, ${signed(baselineKeyword)}, is Claude Code's own response to that prompt. \`claude -p\` carries one prompt, so a plugin that injects on the first prompt of every session shows up in (a) as well and cancels here. OMCA's keyword triggers are off unless \`enableKeywordTriggers\` is set, and this run leaves the default.`,
      "",
      table(["Arm", "Total (a)", "Delta (d) `plan this` vs (a)", "Delta keyword probe vs (a)", "of which hook context"], injectionRows),
    ].join("\n"),
  });

  const startupRows = arms.map((arm) => {
    const own = numbers(okRuns(arm.id, "a"), (r) => r.first_request_ms);
    const diffs = pairedBy(arm.id, "a", (r) => r.first_request_ms);
    return [arm.label, spread(stats(own), 0), arm.id === BASELINE ? "-" : signed(median(diffs))];
  });
  results.startup = Object.fromEntries(arms.map((a) => [a.id, stats(numbers(okRuns(a.id, "a"), (r) => r.first_request_ms))]));
  sections.push({
    title: "4. Startup",
    body: [
      table(["Arm", "Process start to first mock request, ms: median (p25-p75; p95; n)", "Median paired delta vs baseline, ms"], startupRows),
      "",
      "Process start is stamped inside the container just before `claude -p` is executed (host and container share one clock); the first request time is when the host proxy received the request. Claude Code waits for MCP servers to connect before the first request, so a slow or failing MCP server shows up here.",
    ].join("\n"),
  });

  const execPerOf = (arm: string): number | null => {
    const r = raw.firstRun[arm];
    return r?.exec_a && r.exec_b ? (r.exec_b.total - r.exec_a.total) / BASH_CALLS : null;
  };
  const failedRuns = (arm: Arm, kind: string, calls: number): string => {
    const all = runsOf(arm.id, kind);
    const timedOut = all.filter((r) => r.rc === 124).length;
    const otherwise = all.length - okRuns(arm.id, kind).length - timedOut;
    const timeout = arm.limited?.sessions.includes(kind) === true ? arm.limited.timeoutS : SESSION_TIMEOUT_S;
    return `n/a (${timedOut} of ${all.length} runs hit the ${timeout} s timeout${otherwise > 0 ? `, ${otherwise} failed otherwise` : ""}; median ${f0(median(numbers(all, (r) => r.requests)))} of ${calls + 1} requests)`;
  };
  const perCall = (kind: string, calls: number) =>
    arms.map((arm) => {
      const runs = okRuns(arm.id, kind);
      return {
        arm,
        window: numbers(runs, (r) => (r.window_ms === null ? null : r.window_ms / calls)),
        diffs: pairedBy(arm.id, kind, (r) => (r.window_ms === null ? null : r.window_ms / calls)),
        requests: median(numbers(runs, (r) => r.requests)),
      };
    });
  const bashRows = perCall("b", BASH_CALLS).map(({ arm, window, diffs, requests }) => {
    const execPer = execPerOf(arm.id);
    const baseExecPer = execPerOf(BASELINE);
    return [
      arm.label,
      window.length === 0 ? failedRuns(arm, "b", BASH_CALLS) : spread(stats(window), 1),
      arm.id === BASELINE || diffs.length === 0 ? "-" : signed(median(diffs), 1),
      execPer === null ? "n/a" : f1(execPer),
      arm.id === BASELINE || execPer === null || baseExecPer === null ? "-" : signed(execPer - baseExecPer, 1),
      requests === null ? "n/a" : f0(requests),
    ];
  });
  const readRows = perCall("c", READ_CALLS).map(({ arm, window, diffs }) => [
    arm.label,
    window.length === 0 ? failedRuns(arm, "c", READ_CALLS) : spread(stats(window), 1),
    arm.id === BASELINE || diffs.length === 0 ? "-" : signed(median(diffs), 1),
  ]);
  const topExec = plugins.map((arm) => {
    const own = raw.firstRun[arm.id]?.exec_b?.byExe;
    const base = raw.firstRun[BASELINE]?.exec_b?.byExe ?? {};
    if (own === undefined) return `- ${arm.label}: no completed strace run`;
    const extra = Object.entries(own)
      .map(([exe, n]) => [exe, n - (base[exe] ?? 0)] as const)
      .filter(([, n]) => n > 0)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 5)
      .map(([exe, n]) => `${exe} ${n}`);
    return `- ${arm.label}: extra processes over baseline in session (b): ${extra.join(", ") || "none"}`;
  });
  results.per_tool_call = { bash: bashRows, read: readRows };
  sections.push({
    title: "5. Per-tool-call overhead",
    body: [
      `Session (b): ${BASH_CALLS} scripted Bash calls (\`true\`). Time is first request to last main-thread request at the proxy, divided by ${BASH_CALLS}, so startup and shutdown are excluded; it covers ${BASH_CALLS + 1} model requests, ${BASH_CALLS} tool executions and every hook those events trigger. \`execve\` counts come from \`strace -f -e trace=execve\` on one run of (a) and one of (b) per arm (SYS_PTRACE container): (b minus a) divided by ${BASH_CALLS}.`,
      "",
      table(["Arm", "ms per Bash call: median (p25-p75; p95; n)", "Median paired delta vs baseline, ms", "execve per Bash call", "Delta vs baseline", "Median model requests"], bashRows),
      "",
      `Session (c): ${READ_CALLS} Read calls on a fixture file, same method.`,
      "",
      table(["Arm", "ms per Read call: median (p25-p75; p95; n)", "Median paired delta vs baseline, ms"], readRows),
      "",
      ...topExec,
    ].join("\n"),
  });

  const baseSession = new Set(written(raw.firstRun[BASELINE]?.session_diff ?? { created: [], modified: [], deleted: [] }).map((c) => normalize(c.path)));
  const beyondBaseline = (changes: SnapChange[]): SnapChange[] => changes.filter((c) => !baseSession.has(normalize(c.path)));
  const commonSettingsKeys = [...new Set(plugins.flatMap((a) => installOf(a.id)?.settings_keys ?? []))].sort();
  const sameKeys = (keys: string[]): boolean => [...keys].sort().join(",") === commonSettingsKeys.join(",");
  const everyInstallSame = plugins.every((a) => sameKeys(installOf(a.id)?.settings_keys ?? []));
  const instructionEdits = (id: string): string[] => {
    const install = installOf(id);
    const first = raw.firstRun[id];
    const installEdits = install === undefined ? [] : instructionFiles(written(install.outside_plugin_dir)).filter((p) => !(p === "/cfg/settings.json" && everyInstallSame));
    return [...installEdits, ...(first === undefined ? [] : [...instructionFiles(written(first.session_diff)), ...instructionFiles(written(first.project_diff))])];
  };
  const untyped = [...Object.values(raw.install).map((r) => r.outside_plugin_dir), ...Object.values(raw.firstRun).flatMap((r) => [r.session_diff, r.project_diff])].some((d) =>
    written(d).some((c) => c.type === UNKNOWN_TYPE),
  );
  const writeRows = plugins.map((arm) => {
    const install = installOf(arm.id);
    const first = raw.firstRun[arm.id];
    const flagged = [...(install === undefined ? [] : instructionFiles(written(install.outside_plugin_dir))), ...(first === undefined ? [] : [...instructionFiles(written(first.session_diff)), ...instructionFiles(written(first.project_diff))])];
    return [
      arm.label,
      install === undefined ? "n/a" : countWrites(written(install.outside_plugin_dir), untyped).cell,
      first === undefined ? "n/a" : countWrites(beyondBaseline(written(first.session_diff)), untyped).cell,
      first === undefined ? "n/a" : countWrites(written(first.project_diff), untyped).cell,
      flagged.length === 0 ? "none" : flagged.map(code).join(", "),
    ];
  });
  results.writes = Object.fromEntries(arms.map((a) => [a.id, { install: installOf(a.id)?.outside_plugin_dir, session: raw.firstRun[a.id]?.session_diff, project: raw.firstRun[a.id]?.project_diff }]));
  sections.push({
    title: "6. Writes outside the plugin directory",
    body: [
      table(["Arm", "Install: written outside `plugins/cache`", "First session: written beyond what baseline writes (HOME and config dir)", "First session: written in the fixture project (excluding `.git`)", "CLAUDE.md / settings.json touched"], writeRows),
      "",
      `Method: file list with sizes and a short SHA-1 for files under 256 KiB, taken with \`find\` over \`$HOME\`, the config dir and the project before install, after install, and before and after the first session (a). Paths are grouped to four components and ids and timestamps are normalised.${untyped ? " This run did not record whether each new path is a file or a directory, so the counts are paths of either kind." : " The counts are files; directories are left out."} ${everyInstallSame ? `Every install wrote \`settings.json\` in the config dir with the keys ${list(commonSettingsKeys.map(code))} and nothing else; that is Claude Code's own record of the install and is the \`settings.json\` entry in the table.` : `The installs wrote \`settings.json\` keys that differ by arm: ${plugins.map((a) => `${a.label} ${(installOf(a.id)?.settings_keys ?? []).join(", ")}`).join("; ")}.`} No arm created or edited a \`CLAUDE.md\` unless one is named in the last column.`,
    ].join("\n"),
  });

  const asksForFacts = (g: GuardRecord): boolean => /present (?:these|the) facts/i.test(g.result_text);
  const guardIds = [...new Set(raw.guards.map((g) => g.id))];
  const guardCell = (g: GuardRecord | undefined): string => {
    if (g === undefined) return "n/a";
    if (g.ran) {
      if (g.blocked_first && g.attempts > 1) return g.destructive ? `**gated once, ran on retry** (${blockedBy(g.result_text)})` : `gated once, ran on retry (${blockedBy(g.result_text)})`;
      return g.destructive ? "**RAN**" : "ran";
    }
    if (g.destructive) return `blocked (${blockedBy(g.result_text)})`;
    return asksForFacts(g) ? `blocked (${blockedBy(g.result_text)}; mock artifact)` : "**BLOCKED**";
  };
  const guardRows = arms.map((arm) => [arm.label, ...guardIds.map((id) => guardCell(raw.guards.find((g) => g.arm === arm.id && g.id === id)))]);
  const singleAttempt = [...new Set(raw.guards.filter((g) => g.attempts === 1).map((g) => g.arm))].map((id) => {
    const limit = file.arms.find((a) => a.id === id)?.limited?.timeoutS;
    return `${labelOf(id)}${limit === undefined ? "" : `, which runs under a ${limit} s limit`}`;
  });
  results.guards = raw.guards;
  sections.push({
    title: "7. Guard corpus",
    body: [
      table(["Arm", ...guardIds.map((id) => code(raw.guards.find((g) => g.id === id)?.command ?? id))], guardRows),
      "",
      `The mock issues the same Bash call twice per session${singleAttempt.length === 0 ? "" : `, and once for ${list(singleAttempt)},`} under \`--permission-mode bypassPermissions\`, so only hooks can stop it (a guard that lives on \`PermissionRequest\` alone does not fire in this mode). A command counts as RAN when its effect is observable: \`rm -rf /\` when GNU rm printed its own refusal (the command reached the shell; rm's built-in failsafe, not a guard, stopped it), the home sentinel file gone for \`rm -rf ~\`, the tracked file reverted for \`git reset --hard\`, the bare remote's \`main\` moved for \`git push --force\`, a new commit for \`git commit --no-verify\`, the \`build\` directory gone, and expected output for \`git status\` and \`ls\`. Bold marks the wrong outcome: a destructive command that ran, or a benign control that was blocked. "Mock artifact" marks a benign control blocked by a gate that asks the model to present facts and retry: the scripted mock retries without them, which a real model would not do.`,
    ].join("\n"),
  });

  const stopRows = arms.map((arm) => {
    const s = raw.stop.find((x) => x.arm === arm.id);
    if (s === undefined) return [arm.label, "n/a", "n/a", "n/a", "n/a"];
    if (!s.plan_written) return [arm.label, "no", `${s.requests} (expected ${s.expected_requests} without a gate)`, "n/a (no plan file to stop on)", "-"];
    return [arm.label, "yes", `${s.requests} (expected ${s.expected_requests} without a gate)`, s.forced_continue ? "**continued**" : "stopped", s.forced_continue ? s.gate_text.replace(/\s+/g, " ").slice(0, 160) : "-"];
  });
  const unwritten = raw.stop.filter((s) => !s.plan_written);
  results.stop = raw.stop;
  sections.push({
    title: "8. Stop gate",
    body: [
      table(["Arm", "Plan file written", "Model requests", "Outcome of the scripted `done` end turn", "Continuation text"], stopRows),
      "",
      `The script writes a plan file with two unchecked numbered tasks, then ends the turn. For OMCA it also calls \`boulder_write\` through the mock to bind the session to that plan, the supported way to arm its plan gate. The other arms run the same script with no plugin-specific setup, so a \`stopped\` there says only that nothing blocked a stop in this state, not that the arm has no gate; their gates need state this harness does not create. A continuation is counted only when a main-thread request (same system prompt as the first) follows the scripted \`done\` reply; requests with another system prompt add to the request count only.${unwritten.length === 0 ? "" : ` The plan file was not written for ${list(unwritten.map((s) => `${labelOf(s.arm)} (the Write call's result: "${s.tool_results.replace(/\s+/g, " ").slice(0, 120)}")`))}, so the outcome there is n/a: the mock does not act on a gate's denial and goes on to its next scripted turn.`}`,
    ].join("\n"),
  });

  const plainDelta = turn1.deltas[OMCA] ?? null;
  const searchDelta = turn1Search.deltas[OMCA] ?? null;
  const parts = turn1Search.components[OMCA];
  const largest = (deltas: Record<string, number>): string => {
    const top = Object.entries(deltas).filter(([id]) => id !== BASELINE).sort((x, y) => y[1] - x[1])[0];
    return top === undefined ? "n/a" : `${labelOf(top[0])}, at ${signedK(top[1])},`;
  };
  const searchMcpTools = median(searchRuns(OMCA).flatMap((r) => (r.first === null ? [] : [r.first.tools_mcp_n])));
  const alwaysOn = sumDetails(Object.values(installOf(OMCA)?.details ?? {}).map(parseDetails)).always_on_tokens;
  const context = standing((id) => turn1Search.deltas[id] ?? null, 0);
  const startOf = (id: string): number | null => median(pairedBy(id, "a", (r) => r.first_request_ms));
  const callOf = (id: string): number | null => median(pairedBy(id, "b", (r) => (r.window_ms === null ? null : r.window_ms / BASH_CALLS)));
  const startup = standing(startOf, 5);
  const perCallStanding = standing(callOf, 5);
  const footprint = standing((id) => installOf(id)?.cache_bytes ?? null, 0);
  const churn = standing(execPerOf, 0.5);
  const projectWrites = (id: string): SnapChange[] => (raw.firstRun[id] === undefined ? [] : written(raw.firstRun[id].project_diff));
  const projectStanding = standing((id) => (raw.firstRun[id] === undefined ? null : countWrites(projectWrites(id), untyped).count), 1);
  const omcaInstall = installOf(OMCA);
  const omcaHosts = raw.firstRun[OMCA]?.network.hosts.filter((h) => h !== "api.anthropic.com") ?? [];
  const destructiveRan = (arm: string): string[] => raw.guards.filter((g) => g.arm === arm && g.destructive && g.ran).map((g) => code(g.command));
  const destructiveBlocked = (arm: string): string[] => raw.guards.filter((g) => g.arm === arm && g.destructive && !g.ran).map((g) => code(g.command));
  const omcaHooks = hooksJsonSummary(raw.configDirs[OMCA] ?? "");
  const homeWrites = beyondBaseline(written(raw.firstRun[OMCA]?.session_diff ?? { created: [], modified: [], deleted: [] })).filter((c) => c.path.startsWith("/home/"));
  const omcaEdits = instructionEdits(OMCA);
  const worse: string[] = [];
  const notWorse: string[] = [];
  const place = (bad: boolean, text: string): void => {
    (bad ? worse : notWorse).push(text);
  };

  if (parts !== undefined) {
    place(
      isWorse(context),
      `**Context per request.** OMCA adds ${signedK(plainDelta)} estimated tokens to every request in this harness and ${signedK(searchDelta)} with tool search on (the first-party-like case). With tool search on, against the other plugin arms: ${describe(context, "adds less", "adds more")}. The largest addition is ${largest(turn1.deltas)} with tool search off and ${largest(turn1Search.deltas)} with it on. OMCA's parts with tool search on: system prompt ${signed(parts.system)}, MCP tools ${signed(parts.builtin + parts.mcp)} (${f0(searchMcpTools)} MCP tool schemas in the request), hook context ${signed(parts.hook)}, skill and agent listing ${signed(parts.listings)}, output style ${signed(parts.style)}, MCP instructions ${signed(parts.mcpInstr)}. \`claude plugin details\` reports ~${f0(alwaysOn)} always-on tokens for OMCA, which counts only skill, agent and command names and descriptions.`,
    );
  }
  if (raw.noBun !== null) {
    const lost = raw.noBun.mcp_tools === 0 || !raw.noBun.stop_forced;
    place(
      lost,
      `**Without bun.** The probe in section 9 hid bun: the first request carried ${f0(raw.noBun.mcp_tools)} MCP tools and ${f0(raw.noBun.hook_context_tokens)} hook-context tokens, the stop gate ${raw.noBun.stop_forced ? "still continued" : "did not continue"} a plan-bound session, and the Bash guard ${raw.noBun.guards.every((g) => !g.ran) ? "still blocked" : "let through"} ${list(raw.noBun.guards.map((g) => code(raw.guards.find((x) => x.id === g.id)?.command ?? g.id)))}.`,
    );
  }
  if (omcaInstall?.online) {
    worse.push(
      `**Install-time dependency fetch.** The offline install tried a package registry, and the online probe shows the plugin cache growing from ${humanBytes(omcaInstall.cache_bytes)} to ${humanBytes(omcaInstall.online.cache_bytes)} and from ${f0(omcaInstall.cache_files)} to ${f0(omcaInstall.online.cache_files)} files.`,
    );
  }
  place(isWorse(startup), `**Startup.** The first request arrives ${signed(startup.own)} ms after baseline's (median paired). Against the other plugin arms: ${describe(startup, "earlier", "later")}.`);
  place(isWorse(perCallStanding), `**Per Bash call.** Each Bash call costs ${signed(perCallStanding.own, 1)} ms over baseline (median paired). Against the other plugin arms: ${describe(perCallStanding, "faster", "slower")}.`);
  if (omcaHosts.length > 0) worse.push(`**Network at session start.** A session tried to reach ${list(omcaHosts)}, which the closed network refuses.`);
  if (raw.guards.some((g) => g.arm === OMCA)) {
    place(
      destructiveRan(OMCA).length > 0,
      destructiveRan(OMCA).length > 0
        ? `**Guard coverage under bypassPermissions.** OMCA blocked ${list(destructiveBlocked(OMCA)) || "nothing"}, but ${list(destructiveRan(OMCA))} ran.`
        : `**Guard coverage under bypassPermissions.** OMCA blocked every destructive command in the corpus: ${list(destructiveBlocked(OMCA))}.`,
    );
  }
  if (raw.firstRun[OMCA] !== undefined) {
    place(
      isWorse(projectStanding),
      `**Writes in the project.** A first session wrote ${countWrites(projectWrites(OMCA), untyped).label} into the project (${countWrites(projectWrites(OMCA), untyped).groups}) and ${countWrites(homeWrites, untyped).label} under \`$HOME\` beyond what baseline writes (${countWrites(homeWrites, untyped).groups}). Against the other plugin arms, by the project count: ${describe(projectStanding, "fewer", "more")}.`,
    );
  }
  if (omcaInstall !== undefined) {
    place(isWorse(footprint), `**Offline install footprint** is ${humanBytes(omcaInstall.cache_bytes)} in ${f0(omcaInstall.cache_files)} files. Against the other plugin arms: ${describe(footprint, "smaller", "larger")}.`);
  }
  if (churn.own !== null) {
    const allMcpTool = omcaHooks.handlers > 0 && omcaHooks.types.mcp_tool === omcaHooks.handlers;
    place(
      isWorse(churn),
      `**Process churn** is ${f1(churn.own)} \`execve\` per Bash call against ${f1(execPerOf(BASELINE))} for baseline. Against the other plugin arms: ${describe(churn, "fewer", "more")}.${allMcpTool ? ` Every one of OMCA's ${omcaHooks.handlers} \`hooks.json\` handlers is an \`mcp_tool\` call rather than a command.` : ""}`,
    );
  }
  if (raw.firstRun[OMCA] !== undefined && omcaInstall !== undefined) {
    place(
      omcaEdits.length > 0,
      omcaEdits.length === 0
        ? `**No CLAUDE.md or settings edits**${everyInstallSame ? " beyond the `settings.json` entry every install writes" : ""}.`
        : `**CLAUDE.md or settings edits.** ${list(omcaEdits.map(code))}.`,
    );
  }
  const stopOmca = raw.stop.find((s) => s.arm === OMCA);
  const continued = raw.stop.filter((s) => s.plan_written && s.forced_continue).map((s) => labelOf(s.arm));
  sections.splice(1, 0, {
    title: "Where OMCA is worse, and where it is not",
    body: [
      `Each comparison is against the other plugin arms, and a bullet sits under "Worse" when more of them do better than OMCA than do worse. An arm counts as about level when it is within ${LEVEL_SHARE * 100} percent of OMCA's value (and within 5 ms for times and 0.5 \`execve\` for process counts).`,
      "",
      "Worse:",
      "",
      ...(worse.length === 0 ? ["- nothing in this run"] : worse.map((w) => `- ${w}`)),
      "",
      "Not worse:",
      "",
      ...(notWorse.length === 0 ? ["- nothing in this run"] : notWorse.map((w) => `- ${w}`)),
      "",
      `Stop gate, not a comparison: only OMCA's run was armed with plugin state (a bound plan holding unchecked tasks), so section 8 says whether each arm stopped in an unarmed state, not whose gate is better. Arms whose scripted stop was continued: ${list(continued) || "none"}.${stopOmca === undefined ? " OMCA has no stop record." : ""}`,
    ].join("\n"),
  });

  const noBun = raw.noBun;
  if (noBun !== null) {
    results.omca_without_bun = noBun;
    const turn1Omca = breakdownOf(OMCA, "a", "first");
    const withBunGuard = (id: string): string => {
      const g = raw.guards.find((x) => x.arm === OMCA && x.id === id);
      return g === undefined ? "n/a" : g.ran ? "RAN" : "blocked";
    };
    const guardNames = list(noBun.guards.map((g) => code(raw.guards.find((x) => x.id === g.id)?.command ?? g.id)));
    sections.push({
      title: "9. OMCA with bun hidden (probe)",
      body: [
        "The OMCA arm repeated with `/usr/local/bin/bun` replaced by an empty file, so `bun servers/omca.ts` cannot start. One run each, same sessions as above.",
        "",
        table(
          ["Measure", "With bun (median of the paired runs; guards and stop gate from sections 7 and 8)", "Without bun"],
          [
            ["MCP tools in the first request", f0(median(numbers(okRuns(OMCA, "a"), (r) => r.tools_mcp_n))), f0(noBun.mcp_tools)],
            ["Injected hook-context tokens, turn 1", f0(turn1Omca === null ? null : tokens(turn1Omca.hook_context)), f0(noBun.hook_context_tokens)],
            ["Estimated tokens in the first request", f0(turn1Omca === null ? null : tokens(totalOf(turn1Omca))), f0(noBun.first_request_tokens)],
            [`Bash guard (${guardNames})`, noBun.guards.map((g) => withBunGuard(g.id)).join(", "), noBun.guards.map((g) => (g.ran ? "RAN" : "blocked")).join(", ")],
            ["Stop gate continued a plan-bound session", stopOmca === undefined ? "n/a" : stopOmca.forced_continue ? "yes" : "no", noBun.stop_forced ? "yes" : "no"],
          ],
        ),
        "",
        `The Bash guard is a hook module that runs inside Claude Code, not in the MCP server; without bun it ${noBun.guards.every((g) => !g.ran) ? "still blocked every probed command" : "let a probed command run"}.`,
      ].join("\n"),
    });
  }

  const image = (key: string): string => raw.image[key] ?? "n/a";
  const markdown = [
    `# Plugin comparison results, ${raw.date}`,
    "",
    `Claude Code ${raw.claudeVersions.length === 0 ? "(version not found in the recorded request bodies)" : `${list(raw.claudeVersions)} (read from the recorded request bodies)`} in Docker, image from \`Dockerfile\` (${image("FROM")}, node ${image("NODE_VERSION")}, bun ${image("BUN_VERSION")} as the Dockerfile pins them when the report is written), every request answered by a local mock model, no network egress, ${raw.rounds} paired rounds plus one discarded warm-up round. Raw request bodies of the first paired round are in \`results/${raw.date}-raw/\`. See README.md for method and limits.`,
    "",
    ...sections.flatMap((s) => [`## ${s.title}`, "", s.body, ""]),
  ].join("\n");
  return { results, markdown };
}
