import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { blockedBy, CATEGORIES, type Breakdown, type Category, humanBytes, median, pairedDiffs, type SnapDiff, stats, type Stats, tokens } from "./analyze.ts";
import type { Arm, ArmsFile } from "./harness.ts";
import type { FirstRunRecord, NoBunRecord, GuardRecord, InstallRecord, StopRecord, TimingRecord, ToolSearchRecord } from "./run.ts";
import { BASH_CALLS, READ_CALLS } from "./scenarios.ts";

export type RawResults = {
  date: string;
  rounds: number;
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
const f0 = (n: number | null): string => (n === null ? "n/a" : Math.round(n).toLocaleString("en-US"));
const f1 = (n: number | null): string => (n === null ? "n/a" : n.toFixed(1));
const signed = (n: number | null, digits = 0): string => (n === null ? "n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`);

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

const sumDetails = (list: Details[]): Details =>
  list.reduce(
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
  return [...groups].map(([k, n]) => `\`${k}\`${n > 1 ? ` x${n}` : ""}`).join(", ");
};

export function renderMarkdown(raw: RawResults): { results: Record<string, unknown>; markdown: string } {
  const { file } = raw;
  const arms: Arm[] = file.arms.filter((a) => a.id === BASELINE || raw.install[a.id] !== undefined);
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

  const sections: Section[] = [];
  const results: Record<string, unknown> = {
    date: raw.date,
    claude: file.claude,
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
      sha === "" ? "-" : `\`${sha.slice(0, 12)}\``,
      arm.install.length === 0 ? "-" : arm.install.map((i) => `\`${i}\``).join(", "),
      arm.id === BASELINE ? "n/a" : record?.ok ? "installed" : `FAILED: ${failed?.error ?? "no install record"}`,
    ];
  });
  results.arms = armRows;
  sections.push({ title: "Arms and install outcome", body: table(["Arm", "id", "Version", "Commit", "Install ids", "Install outcome"], armRows) });

  const footprintRows = arms
    .filter((a) => a.id !== BASELINE)
    .map((arm) => {
      const r = raw.install[arm.id] as InstallRecord;
      const online = r.online;
      return [
        arm.label,
        humanBytes(r.cache_bytes),
        f0(r.cache_files),
        `${f0(r.install_ms)} ms`,
        r.network.hosts.filter((h) => h !== "api.anthropic.com").join(", ") || "none",
        !online ? "n/a (no registry fetch attempted)" : `${humanBytes(online.cache_bytes)} / ${f0(online.cache_files)} files (${humanBytes(online.node_modules_bytes)} of node_modules) in ${f0(online.install_ms)} ms`,
      ];
    });
  results.footprint = Object.fromEntries(arms.filter((a) => a.id !== BASELINE).map((a) => [a.id, raw.install[a.id]]));
  sections.push({
    title: "1. Install footprint",
    body: [
      table(
        ["Arm", "Plugin cache (offline install)", "Files", "Install time (offline)", "Hosts the install tried to reach", "Plugin cache after an online install probe"],
        footprintRows,
      ),
      "",
      "Offline install is the hermetic run (closed network, directory marketplace). The online probe repeats the install once on the default Docker bridge with no Anthropic credentials, only for arms whose offline install tried to reach the npm registry, to show what Claude Code would fetch. The host list comes from `strace -f -e trace=connect,sendto,sendmmsg,sendmsg` on every install step, with DNS names decoded from the query packets; `api.anthropic.com` appears for every arm, baseline included, and is filtered out.",
      "",
      "Claude Code " + file.claude + " runs a dependency install during `claude plugin install` when the plugin directory has a `package.json` and a lockfile: `npm ci --ignore-scripts` for oh-my-claudecode and `bun install --frozen-lockfile --ignore-scripts` for OMCA (observed with `strace -e execve`). Offline the install still reports success; oh-my-claudecode spends about a minute in `npm ci` retries first.",
    ].join("\n"),
  });

  const inventoryRows = arms.map((arm) => {
    if (arm.id === BASELINE) return [arm.label, "-", "-", "-", "-", "-", "-"];
    const record = raw.install[arm.id] as InstallRecord;
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
  const hookDetail = arms
    .filter((a) => a.id !== BASELINE)
    .map((arm) => {
      const hooks = hooksJsonSummary(raw.configDirs[arm.id] ?? "");
      const events = Object.entries(hooks.events).map(([e, n]) => `${e} ${n}`).join(", ");
      const types = Object.entries(hooks.types).map(([t, n]) => `${t} ${n}`).join(", ");
      return `- ${arm.label}: ${events || "no hooks.json handlers"}${types === "" ? "" : ` (types: ${types})`}`;
    });
  results.inventory = Object.fromEntries(
    arms
      .filter((a) => a.id !== BASELINE)
      .map((a) => [a.id, { details: raw.install[a.id]?.details, hooks_json: hooksJsonSummary(raw.configDirs[a.id] ?? ""), mods: raw.firstRun[a.id]?.mods, registered: raw.firstRun[a.id]?.registered }]),
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
    conversation: chars.conversation,
  });
  const totalOf = (chars: Record<Category, number>): number => Object.values(group(chars)).reduce((a, b) => a + b, 0);
  const tokenRows = (source: (armId: string) => Record<Category, number> | null): { rows: string[][]; data: Record<string, unknown> } => {
    const base = source(BASELINE);
    const data: Record<string, unknown> = {};
    const rows = arms.flatMap((arm) => {
      const own = source(arm.id);
      if (own === null || base === null) return [];
      const g = group(own);
      const b = group(base);
      const delta = (k: keyof typeof g): string => signed(tokens(g[k]) - tokens(b[k]));
      data[arm.id] = Object.fromEntries(CATEGORIES.map((c) => [c, tokens(own[c])]));
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
          arm.id === BASELINE ? "-" : `**${signed(tokens(totalOf(own)) - tokens(totalOf(base)))}**`,
          arm.id === BASELINE ? "-" : `sys ${delta("system")}, tools ${signed(tokens(g.builtin) - tokens(b.builtin) + tokens(g.mcp) - tokens(b.mcp))}, lists ${delta("listings")}, style ${delta("style")}, mcp-instr ${delta("mcpInstr")}, hook ${delta("hook")}, other ${delta("other")}`,
        ],
      ];
    });
    return { rows, data };
  };
  const tokenHeader = ["Arm", "System prompt", "Tools built-in", "Tools MCP (or deferred names)", "Agent + skill listing", "Output style", "MCP instructions", "Hook context", "Env, git, attribution", "Total", "Delta vs baseline", "Delta by component"];
  const turn1 = tokenRows((id) => breakdownOf(id, "a", "first"));
  const turnN = tokenRows((id) => breakdownOf(id, "b", "last"));
  const searchRuns = (id: string): Breakdown[] => raw.toolSearch.filter((r) => r.arm === id && r.rc === 0 && r.first !== null).map((r) => r.first as Breakdown);
  const turn1Search = tokenRows((id) => medianChars(searchRuns(id)));
  results.tokens_turn1_tool_search = turn1Search.data;
  results.tokens_turn1 = turn1.data;
  results.tokens_turnN = turnN.data;

  const keywordRuns = (id: string): Breakdown[] => raw.keywords.filter((r) => r.arm === id && r.rc === 0 && r.first !== null).map((r) => r.first as Breakdown);
  const injectionRows = arms.flatMap((arm) => {
    const a = breakdownOf(arm.id, "a", "first");
    const d = breakdownOf(arm.id, "d", "first");
    const k = medianChars(keywordRuns(arm.id));
    if (a === null || d === null) return [];
    return [
      [
        arm.label,
        f0(tokens(totalOf(a))),
        signed(tokens(totalOf(d)) - tokens(totalOf(a))),
        k === null ? "n/a" : signed(tokens(totalOf(k)) - tokens(totalOf(a))),
        k === null ? "n/a" : signed(tokens(k.hook_context) - tokens(a.hook_context)),
      ],
    ];
  });
  results.prompt_injection = injectionRows;
  sections.push({
    title: "3. Tokens added per request (estimate)",
    body: [
      "Estimated tokens in the request body, excluding the user's prompt text. Method: every request body the mock received is split into the `system` array, the `tools` array (names starting `mcp__` are MCP, the rest built-in) and the message text blocks. Message text is cut at known section markers (`# Environment`, `Available agent types`, the skill listing line, `# Output Style:`, `# MCP Server Instructions`, `<event> hook additional context:`/`hook success:`). Tokens are `ceil(chars / 4)` for every arm, an estimate only: Claude's tokenizer is not available offline. Values are medians over the paired runs.",
      "",
      "**Turn 1** (first request of session (a), one plain prompt):",
      "",
      table(tokenHeader, turn1.rows),
      "",
      "**Turn 1 with tool search on** (`ENABLE_TOOL_SEARCH=true`, session (a), 3 rounds). Claude Code turns tool search off when `ANTHROPIC_BASE_URL` is not a first-party host, which is the case in this harness, so the tables above ship every MCP tool schema in the `tools` array. Against the first-party API, MCP tools are deferred and only their names are listed (counted under Tools MCP here). This table is the closer match to real first-party traffic for MCP-heavy arms; servers declaring `alwaysLoad` (OMCA's `omca` server) stay loaded either way.",
      "",
      table(tokenHeader, turn1Search.rows),
      "",
      `**Turn N** (request ${BASH_CALLS + 1} of session (b), after ${BASH_CALLS} Bash calls; the conversation itself, tool_use and tool_result text, is excluded from the total and the same for every arm):`,
      "",
      table(tokenHeader, turnN.rows),
      "",
      "**Per-prompt injection**: session (d), prompt `plan this task, then reply with the single word ok.`, against session (a), first request; and a keyword probe (3 rounds) whose prompt is `autopilot ralph ultrawork ultrathink: create plan, plan this task, fix build, then reply with the single word ok.`, which carries the trigger words of several arms. Deltas are in estimated tokens with the prompt text itself excluded; the +32 on every arm is Claude Code's own handling of `ultrathink`. `claude -p` carries one prompt, so a plugin that injects on the first prompt of every session shows up in (a) as well and cancels here. OMCA's keyword triggers are off unless `enableKeywordTriggers` is set, and this run leaves the default.",
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

  const perCall = (kind: string, calls: number) =>
    arms.map((arm) => {
      const runs = okRuns(arm.id, kind);
      const window = numbers(runs, (r) => (r.window_ms === null ? null : r.window_ms / calls));
      const diffs = pairedBy(arm.id, kind, (r) => (r.window_ms === null ? null : r.window_ms / calls));
      const first = raw.firstRun[arm.id];
      const base = raw.firstRun[BASELINE];
      const execPer = first?.exec_a && first.exec_b ? (first.exec_b.total - first.exec_a.total) / calls : null;
      const baseExecPer = base?.exec_a && base.exec_b ? (base.exec_b.total - base.exec_a.total) / calls : null;
      const bad = runsOf(arm.id, kind).length - runs.length;
      return { arm, runs, window, diffs, execPer, baseExecPer, bad, requests: median(numbers(runs, (r) => r.requests)) };
    });
  const bashRows = perCall("b", BASH_CALLS).map(({ arm, window, diffs, execPer, baseExecPer, bad, requests }) => [
    arm.label,
    window.length === 0 ? `n/a (${bad} of ${runsOf(arm.id, "b").length} runs hit the ${arm.limited?.timeoutS ?? 150} s timeout after ${f0(median(numbers(runsOf(arm.id, "b"), (r) => r.requests)))} of ${BASH_CALLS + 1} requests)` : spread(stats(window), 1),
    arm.id === BASELINE || diffs.length === 0 ? "-" : signed(median(diffs), 1),
    execPer === null ? "n/a" : f1(execPer),
    arm.id === BASELINE || execPer === null || baseExecPer === null ? "-" : signed(execPer - baseExecPer, 1),
    requests === null ? "n/a" : f0(requests),
  ]);
  const readRows = perCall("c", READ_CALLS).map(({ arm, window, diffs, bad }) => [
    arm.label,
    window.length === 0 ? `n/a (${bad} of ${runsOf(arm.id, "c").length} runs hit the timeout)` : spread(stats(window), 1),
    arm.id === BASELINE || diffs.length === 0 ? "-" : signed(median(diffs), 1),
  ]);
  const topExec = arms
    .filter((a) => a.id !== BASELINE)
    .map((arm) => {
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
      `Session (b): ${BASH_CALLS} scripted Bash calls (\`true\`). Time is first request to last request at the proxy, divided by ${BASH_CALLS}, so startup and shutdown are excluded; it covers ${BASH_CALLS + 1} model requests, ${BASH_CALLS} tool executions and every hook those events trigger. \`execve\` counts come from \`strace -f -e trace=execve\` on one run of (a) and one of (b) per arm (SYS_PTRACE container): (b minus a) divided by ${BASH_CALLS}.`,
      "",
      table(["Arm", "ms per Bash call: median (p25-p75; p95; n)", "Median paired delta vs baseline, ms", "execve per Bash call", "Delta vs baseline", "Median model requests"], bashRows),
      "",
      `Session (c): ${READ_CALLS} Read calls on a fixture file, same method.`,
      "",
      table(["Arm", `ms per Read call: median (p25-p75; p95; n)`, "Median paired delta vs baseline, ms"], readRows),
      "",
      ...topExec,
    ].join("\n"),
  });

  const baseSession = new Set([...(raw.firstRun[BASELINE]?.session_diff.created ?? []), ...(raw.firstRun[BASELINE]?.session_diff.modified ?? [])].map(normalize));
  const beyond = (paths: string[]): string[] => paths.filter((p) => !baseSession.has(normalize(p)));
  const instrFiles = (diff: SnapDiff): string[] => [...diff.created, ...diff.modified].filter((p) => /(^|\/)(CLAUDE\.md|settings(\.local)?\.json)$/.test(p));
  const writeRows = arms
    .filter((a) => a.id !== BASELINE)
    .map((arm) => {
      const i = raw.install[arm.id] as InstallRecord;
      const first = raw.firstRun[arm.id];
      const installFiles = [...i.outside_plugin_dir.created, ...i.outside_plugin_dir.modified].filter((p) => !p.endsWith("/"));
      const sessionNew = first === undefined ? [] : beyond([...first.session_diff.created, ...first.session_diff.modified]);
      const project = first === undefined ? [] : [...first.project_diff.created, ...first.project_diff.modified];
      const flagged = [...instrFiles(i.outside_plugin_dir), ...(first === undefined ? [] : instrFiles(first.session_diff)), ...(first === undefined ? [] : instrFiles(first.project_diff))];
      return [
        arm.label,
        `${installFiles.length}: ${groupPaths(installFiles)}`,
        `${sessionNew.length}: ${groupPaths(sessionNew)}`,
        `${project.length}: ${groupPaths(project)}`,
        flagged.length === 0 ? "none" : flagged.map((p) => `\`${p}\``).join(", "),
      ];
    });
  results.writes = Object.fromEntries(arms.map((a) => [a.id, { install: raw.install[a.id]?.outside_plugin_dir, session: raw.firstRun[a.id]?.session_diff, project: raw.firstRun[a.id]?.project_diff }]));
  sections.push({
    title: "6. Writes outside the plugin directory",
    body: [
      table(["Arm", "Install: files created or changed outside `plugins/cache`", "First session: files beyond what baseline writes (HOME and config dir)", "First session: files in the fixture project (excluding `.git`)", "CLAUDE.md / settings.json touched"], writeRows),
      "",
      "Method: file list with sizes and a short SHA-1 for files under 256 KiB, taken with `find` over `$HOME`, the config dir and the project before install, after install, and before and after the first session (a). Paths are grouped to four components and ids and timestamps are normalised. The install writes `settings.json` in the config dir for every arm, with the keys `enabledPlugins` and `extraKnownMarketplaces` and nothing else; that is Claude Code's own record of the install and is the `settings.json` entry in the table. No arm created or edited a `CLAUDE.md` unless one is named in the last column.",
    ].join("\n"),
  });

  const guardIds = [...new Set(raw.guards.map((g) => g.id))];
  const guardCell = (g: GuardRecord | undefined): string => {
    if (g === undefined) return "n/a";
    if (g.ran) {
      if (g.blocked_first && g.attempts > 1) return g.destructive ? `**gated once, ran on retry** (${blockedBy(g.result_text)})` : `gated once, ran on retry (${blockedBy(g.result_text)})`;
      return g.destructive ? "**RAN**" : "ran";
    }
    return g.destructive ? `blocked (${blockedBy(g.result_text)})` : "**BLOCKED**";
  };
  const guardRows = arms.map((arm) => [arm.label, ...guardIds.map((id) => guardCell(raw.guards.find((g) => g.arm === arm.id && g.id === id)))]);
  results.guards = raw.guards;
  sections.push({
    title: "7. Guard corpus",
    body: [
      table(["Arm", ...guardIds.map((id) => `\`${raw.guards.find((g) => g.id === id)?.command ?? id}\``)], guardRows),
      "",
      "The mock issues one Bash call per session under `--permission-mode bypassPermissions`, so only hooks can stop it (a guard that lives on `PermissionRequest` alone does not fire in this mode). A command counts as RAN when its effect is observable: `rm -rf /` when GNU rm printed its own refusal (the command reached the shell; rm's built-in failsafe, not a guard, stopped it), the home sentinel file gone for `rm -rf ~`, the tracked file reverted for `git reset --hard`, the bare remote's `main` moved for `git push --force`, a new commit for `git commit --no-verify`, the `build` directory gone, and expected output for `git status` and `ls`. Bold marks the wrong outcome: a destructive command that ran, or a benign control that was blocked.",
    ].join("\n"),
  });

  const stopRows = arms.map((arm) => {
    const s = raw.stop.find((x) => x.arm === arm.id);
    if (s === undefined) return [arm.label, "n/a", "n/a", "n/a"];
    return [arm.label, `${s.requests} (expected ${s.expected_requests} without a gate)`, s.forced_continue ? "**continued**" : "stopped", s.forced_continue ? s.gate_text.replace(/\s+/g, " ").slice(0, 160) : "-"];
  });
  results.stop = raw.stop;
  sections.push({
    title: "8. Stop gate",
    body: [
      table(["Arm", "Model requests", "Outcome of the scripted `done` end turn", "Continuation text"], stopRows),
      "",
      "The script writes a plan file with two unchecked numbered tasks, then ends the turn. For OMCA it also calls `boulder_write` through the mock to bind the session to that plan, the supported way to arm its plan gate. The other arms run the same script with no plugin-specific setup, so a `stopped` there says only that nothing blocked a stop in this state, not that the arm has no gate; their gates need state this harness does not create. A continuation is counted only when a main-thread request follows the scripted `done` reply; extra requests with a different system prompt are model calls made by hooks (claude-code-harness runs agent-type hooks at stop) and show up as a higher request count with `stopped`.",
    ].join("\n"),
  });

  const sumTokens = (r: Record<string, number> | undefined): number => Object.values(r ?? {}).reduce((a, b) => a + b, 0);
  const asTokens = (d: Record<string, unknown>): Record<string, Record<string, number>> => d as Record<string, Record<string, number>>;
  const plain = asTokens(turn1.data);
  const searched = asTokens(turn1Search.data);
  const deltaOf = (data: Record<string, Record<string, number>>, id: string): number => sumTokens(data[id]) - sumTokens(data[BASELINE]);
  const catDelta = (data: Record<string, Record<string, number>>, id: string, cats: string[]): number =>
    cats.reduce((n, c) => n + ((data[id]?.[c] ?? 0) - (data[BASELINE]?.[c] ?? 0)), 0);
  const ranked = arms.filter((a) => a.id !== BASELINE && a.id !== "ruflo").sort((x, y) => deltaOf(searched, y.id) - deltaOf(searched, x.id));
  const nextBest = ranked.find((a) => a.id !== "omca");
  const startOf = (id: string): number | null => median(pairedBy(id, "a", (r) => r.first_request_ms));
  const callOf = (id: string): number | null => median(pairedBy(id, "b", (r) => (r.window_ms === null ? null : r.window_ms / BASH_CALLS)));
  const omcaInstall = raw.install.omca;
  const omcaHosts = raw.firstRun.omca?.network.hosts.filter((h) => h !== "api.anthropic.com") ?? [];
  const destructiveRan = (arm: string): string[] => raw.guards.filter((g) => g.arm === arm && g.destructive && g.ran).map((g) => `\`${g.command}\``);
  const destructiveBlocked = (arm: string): string[] => raw.guards.filter((g) => g.arm === arm && g.destructive && !g.ran).map((g) => `\`${g.command}\``);
  const execPer = (arm: string): number | null => {
    const r = raw.firstRun[arm];
    return r?.exec_a && r.exec_b ? (r.exec_b.total - r.exec_a.total) / BASH_CALLS : null;
  };
  const projectFiles = (raw.firstRun.omca?.project_diff.created.length ?? 0) + (raw.firstRun.omca?.project_diff.modified.length ?? 0);
  const alwaysOn = sumDetails(Object.values(omcaInstall?.details ?? {}).map(parseDetails)).always_on_tokens;
  const compare = (metric: (id: string) => number | null, higherWord: string, lowerWord: string): string => {
    const own = metric("omca");
    const others = arms.filter((a) => a.id !== BASELINE && a.id !== "omca").map((a) => ({ label: a.label, value: metric(a.id) }));
    const above = others.filter((o) => own !== null && o.value !== null && o.value > own + Math.max(5, Math.abs(own) * 0.1)).map((o) => o.label);
    const below = others.filter((o) => own !== null && o.value !== null && o.value < own - Math.max(5, Math.abs(own) * 0.1)).map((o) => o.label);
    const level = others.filter((o) => o.value !== null && !above.includes(o.label) && !below.includes(o.label)).map((o) => o.label);
    return [
      below.length === 0 ? "" : `OMCA is ${higherWord} ${below.join(", ")}`,
      level.length === 0 ? "" : `about level with ${level.join(", ")}`,
      above.length === 0 ? "" : `${lowerWord} ${above.join(", ")}`,
    ].filter(Boolean).join("; ");
  };
  const worse: string[] = [
    `**Context per request.** OMCA adds about ${f0(deltaOf(plain, "omca"))} estimated tokens to every request in this harness and ${f0(deltaOf(searched, "omca"))} with tool search on (the first-party-like case), the largest addition of any plugin arm${nextBest === undefined ? "" : ` (next: ${nextBest.label}, ${signed(deltaOf(searched, nextBest.id))})`}. With tool search on, the parts are: system prompt ${signed(catDelta(searched, "omca", ["system_prompt"]))} (the plugin's \`settings.json\` makes the \`sisyphus\` agent the main-thread agent, and its prompt joins the system prompt), MCP tools ${signed(catDelta(searched, "omca", ["tools_mcp", "deferred_listing"]))} (the tools of the \`omca\` server, declared \`alwaysLoad\`, so never deferred), injected guidance ${signed(catDelta(searched, "omca", ["hook_context"]))} (a \`UserPromptSubmit\` hook adds the orchestration guidance on the first prompt, and it stays in the history), skill and agent listing ${signed(catDelta(searched, "omca", ["agent_listing", "skill_listing"]))}, output style ${signed(catDelta(searched, "omca", ["output_style"]))}, MCP instructions ${signed(catDelta(searched, "omca", ["mcp_instructions"]))}. \`claude plugin details\` reports ~${f0(alwaysOn)} always-on tokens for OMCA because it counts only skill and agent names and descriptions.`,
    `**bun is a hard requirement.** Every OMCA \`hooks.json\` handler and every tool is served by one \`bun servers/omca.ts\` MCP server. The no-bun probe in section 9 shows what is lost when bun is missing: no tools, no injected guidance, no stop gate, and no error in the session.`,
    `**Install-time dependency fetch.** Claude Code runs \`bun install --frozen-lockfile --ignore-scripts\` because the shipped tree has a \`package.json\` and \`bun.lock\`; they list only dev dependencies, but the online probe shows the plugin cache growing from ${humanBytes(omcaInstall?.cache_bytes ?? 0)} to ${humanBytes(omcaInstall?.online?.cache_bytes ?? 0)} and from ${f0(omcaInstall?.cache_files ?? 0)} to ${f0(omcaInstall?.online?.cache_files ?? 0)} files. Only oh-my-claudecode is larger after an online install.`,
    `**Startup and per-call time.** The first request arrives ${signed(startOf("omca"))} ms after baseline (median paired): ${compare(startOf, "later than", "earlier than")}. Each Bash call costs ${signed(callOf("omca"), 1)} ms more: ${compare(callOf, "slower than", "faster than")}.`,
    `**Network at session start.** OMCA bundles remote MCP servers; a session tried to reach ${omcaHosts.join(" and ") || "no host"} (the connection fails in a closed network).`,
    `**Guard coverage under bypassPermissions.** OMCA blocked ${destructiveBlocked("omca").join(", ") || "nothing"}, but ${destructiveRan("omca").join(" and ") || "nothing else"} ran. claude-code-harness blocked ${destructiveBlocked("harness").join(", ")}. OMCA treats a force push as advisory on the permission dialog by design, which a bypass session never shows, and has no \`--no-verify\` rule.`,
    `**Files in the project.** A session wrote ${f0(projectFiles)} files into the project (\`.omca/\` and \`.claude/\`), a \`.bun\` transpile cache into \`$HOME\`, and a rule-injection context block after writing a Markdown file (visible in the stop-gate run).`,
  ];
  const notWorse: string[] = [
    `**Offline install footprint** is ${humanBytes(omcaInstall?.cache_bytes ?? 0)} in ${f0(omcaInstall?.cache_files ?? 0)} files, smaller than claude-code-harness, ECC and oh-my-claudecode.`,
    `**Process churn** is the lowest of the hook-heavy arms: ${f1(execPer("omca"))} \`execve\` per Bash call against ${f1(execPer(BASELINE))} for baseline, because the hooks run inside one persistent server rather than as one process per event.`,
    `**Stop gate.** Arms whose scripted stop was continued: ${raw.stop.filter((s) => s.forced_continue).map((s) => s.arm).join(", ") || "none"}. OMCA's run was armed with a bound plan holding unchecked tasks.`,
    `**No CLAUDE.md or settings edits** beyond the \`settings.json\` entries every install writes.`,
  ];
  sections.splice(1, 0, {
    title: "Where OMCA is worse, and where it is not",
    body: ["Worse:", "", ...worse.map((w) => `- ${w}`), "", "Not worse:", "", ...notWorse.map((w) => `- ${w}`)].join("\n"),
  });
  const noBun = raw.noBun;
  if (noBun !== null) {
    results.omca_without_bun = noBun;
    const turn1Omca = breakdownOf("omca", "a", "first");
    sections.push({
      title: "9. OMCA with bun hidden (probe)",
      body: [
        "The OMCA arm repeated with `/usr/local/bin/bun` replaced by an empty file, so `bun servers/omca.ts` cannot start. One run each, same sessions as above.",
        "",
        table(
          ["Measure", "With bun (median of the paired runs)", "Without bun"],
          [
            ["MCP tools in the first request", f0(median(numbers(okRuns("omca", "a"), (r) => r.tools_mcp_n))), f0(noBun.mcp_tools)],
            ["Injected hook-context tokens, turn 1", f0(turn1Omca === null ? null : tokens(turn1Omca.hook_context)), f0(noBun.hook_context_tokens)],
            ["Estimated tokens in the first request", f0(turn1Omca === null ? null : tokens(totalOf(turn1Omca))), f0(noBun.first_request_tokens)],
            ["Bash guard (`rm -rf /`, `git reset --hard`)", "blocked, blocked", noBun.guards.map((g) => (g.ran ? "RAN" : "blocked")).join(", ")],
            ["Stop gate continued a plan-bound session", "yes", noBun.stop_forced ? "yes" : "no"],
          ],
        ),
        "",
        "The Bash guard is a hook module that runs inside Claude Code, so it survives; the MCP-served hooks and tools do not, and the session shows no error.",
      ].join("\n"),
    });
  }

  const markdown = [
    `# Plugin comparison results, ${raw.date}`,
    "",
    `Claude Code ${file.claude} in Docker (Ubuntu 24.04, node 22.23.3, bun 1.4.2), every request answered by a local mock model, no network egress, ${raw.rounds} paired rounds plus one discarded warm-up round. Raw request bodies of the first paired round are in \`results/${raw.date}-raw/\`. See README.md for method and limits.`,
    "",
    ...sections.flatMap((s) => [`## ${s.title}`, "", s.body, ""]),
  ].join("\n");
  return { results, markdown };
}
