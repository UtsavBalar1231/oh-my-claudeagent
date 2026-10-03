import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Breakdown, CATEGORIES } from "./analyze.ts";
import type { Arm, ArmsFile } from "./harness.ts";
import { type RawResults, renderMarkdown } from "./report.ts";
import type { InstallRecord, TimingRecord } from "./run.ts";

const baseline: Arm = { id: "baseline", label: "baseline", tree: null, install: [], details: [] };
const omca: Arm = {
  id: "omca",
  label: "OMCA",
  tree: { kind: "local-head", marketplaceName: "omca" },
  install: ["oh-my-claudeagent@omca"],
  details: ["oh-my-claudeagent"],
};
const FILE: ArmsFile = { claude: "9.9.9", network: { name: "n", subnet: "10.0.0.0/24", gateway: "10.0.0.1" }, arms: [baseline, omca] };

const ZERO = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
const breakdown = (chars: Record<string, number>): Breakdown => ({
  chars: { ...ZERO, ...chars } as Breakdown["chars"],
  prompt_chars: 10,
  tools_builtin_n: 5,
  tools_mcp_n: 0,
  mcp_servers: {},
});
const BASELINE_CHARS = { system_prompt: 4000, tools_builtin: 8000 };
const OMCA_CHARS = { system_prompt: 12000, tools_builtin: 8000, tools_mcp: 4000, hook_context: 400 };

const timing = (arm: string, round: number, firstRequestMs: number, chars: Record<string, number>): TimingRecord => ({
  arm,
  kind: "a",
  round,
  rc: 0,
  requests: 1,
  first_request_ms: firstRequestMs,
  window_ms: 0,
  wall_ms: 1000,
  tools_n: 5,
  tools_mcp_n: 0,
  first: breakdown(chars),
  last: breakdown(chars),
  final_tool_results: 0,
  foreign_clients: [],
  stderr: "",
});

const install: InstallRecord = {
  arm: "omca",
  ok: true,
  steps: [],
  install_ms: 3500,
  cache_bytes: 2048,
  cache_files: 12,
  node_modules_files: 0,
  config_bytes: 0,
  details: { "oh-my-claudeagent": "Skills (2)\nAgents (1)\nHooks (3)\nMCP servers (1)\nAlways-on: ~1,234 tokens" },
  outside_plugin_dir: { created: [], modified: [], deleted: [] },
  network: { hosts: ["api.anthropic.com", "registry.npmjs.org"], connects: [] },
  settings_keys: ["enabledPlugins"],
  online: null,
};

const root = mkdtempSync(join(tmpdir(), "compare-report-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const omcaConfig = join(root, "omca-config");
mkdirSync(join(omcaConfig, "plugins", "cache", "p", "hooks"), { recursive: true });
writeFileSync(
  join(omcaConfig, "plugins", "cache", "p", "hooks", "hooks.json"),
  JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command" }, { type: "command" }] }], Stop: [{ hooks: [{ type: "prompt" }] }] } }),
);

const raw: RawResults = {
  date: "2026-01-01",
  rounds: 3,
  file: FILE,
  treeShas: { omca: "abcdef0123456789" },
  install: { omca: install },
  firstRun: {},
  timing: [
    ...[0, 1, 2].map((round) => timing("baseline", round, 100 + 10 * round, BASELINE_CHARS)),
    ...[0, 1, 2].map((round) => timing("omca", round, 150 + 10 * round, OMCA_CHARS)),
  ],
  guards: [
    { arm: "omca", id: "rm-rf-root", command: "rm -rf /", destructive: true, ran: false, blocked_by: "Claude Code built-in check", result_text: "Dangerous rm operation detected", is_error: true, attempts: 2, blocked_first: true },
    { arm: "omca", id: "git-push-force", command: "git push --force origin main", destructive: true, ran: true, blocked_by: "", result_text: "", is_error: false, attempts: 2, blocked_first: false },
    { arm: "omca", id: "ls", command: "ls", destructive: false, ran: false, blocked_by: "unattributed", result_text: "denied", is_error: true, attempts: 2, blocked_first: true },
    { arm: "baseline", id: "ls", command: "ls", destructive: false, ran: true, blocked_by: "", result_text: "", is_error: false, attempts: 2, blocked_first: false },
  ],
  stop: [
    { arm: "omca", requests: 3, expected_requests: 3, forced_continue: true, plan_written: true, gate_text: "Stop hook blocked", tool_results: "" },
    { arm: "baseline", requests: 2, expected_requests: 2, forced_continue: false, plan_written: true, gate_text: "", tool_results: "" },
  ],
  toolSearch: [0, 1].flatMap((round) => [
    { arm: "baseline", round, rc: 0, tools_n: 5, first: breakdown(BASELINE_CHARS) },
    { arm: "omca", round, rc: 0, tools_n: 5, first: breakdown(OMCA_CHARS) },
  ]),
  keywords: [],
  noBun: null,
  configDirs: { omca: omcaConfig },
};

const { results, markdown } = renderMarkdown(raw);
const lines = markdown.split("\n");

describe("renderMarkdown", () => {
  test("opens with the date, client version and round count", () => {
    expect(lines[0]).toBe("# Plugin comparison results, 2026-01-01");
    expect(lines[2]).toContain("Claude Code 9.9.9 in Docker");
    expect(lines[2]).toContain("3 paired rounds plus one discarded warm-up round");
  });

  test("lists each arm with its pinned commit and install outcome", () => {
    expect(lines).toContain("| baseline | baseline | - | - | - | n/a |");
    expect(lines).toContain("| OMCA | omca | - | `abcdef012345` | `oh-my-claudeagent@omca` | installed |");
  });

  test("reports the install footprint without the Anthropic host", () => {
    expect(lines).toContain("| OMCA | 2.0 KiB | 12 | 3,500 ms | registry.npmjs.org | n/a (no registry fetch attempted) |");
  });

  test("summarises the plugin's hooks.json and details output", () => {
    expect(lines).toContain("| OMCA | 2 / 1 | ~1,234 | 3 handlers over 2 events | - | n/a | 0 (min 0, max 0) |");
    expect(lines).toContain("- OMCA: PreToolUse 2, Stop 1 (types: command 2, prompt 1)");
  });

  test("counts tokens per request with the same estimator for every arm", () => {
    const row = "| OMCA | 3,000 | 2,000 | 1,000 | 0 | 0 | 0 | 100 | 0 | 6,100 | **+3100** | sys +2000, tools +1000, lists +0, style +0, mcp-instr +0, hook +100, other +0 |";
    expect(lines.filter((line) => line === row)).toHaveLength(2);
    expect(lines).toContain("| baseline | 1,000 | 2,000 | 0 | 0 | 0 | 0 | 0 | 0 | 3,000 | - | - |");
  });

  test("keeps the tool-search token counts in the JSON, category by category", () => {
    const tokens = results.tokens_turn1_tool_search as Record<string, Record<string, number>>;
    expect(tokens.baseline).toEqual({ ...ZERO, system_prompt: 1000, tools_builtin: 2000 });
    expect(tokens.omca).toEqual({ ...ZERO, system_prompt: 3000, tools_builtin: 2000, tools_mcp: 1000, hook_context: 100 });
  });

  test("gives startup as a median with its spread and the paired delta against baseline", () => {
    expect(lines).toContain("| baseline | 110 (105-115; p95 120; n=3) | - |");
    expect(lines).toContain("| OMCA | 160 (155-165; p95 170; n=3) | +50 |");
  });

  test("marks the wrong guard outcomes in bold", () => {
    expect(lines).toContain("| Arm | `rm -rf /` | `git push --force origin main` | `ls` |");
    expect(lines).toContain("| OMCA | blocked (Claude Code built-in check) | **RAN** | **BLOCKED** |");
    expect(lines).toContain("| baseline | n/a | n/a | ran |");
  });

  test("shows whether the scripted stop was continued", () => {
    expect(lines).toContain("| OMCA | 3 (expected 3 without a gate) | **continued** | Stop hook blocked |");
    expect(lines).toContain("| baseline | 2 (expected 2 without a gate) | stopped | - |");
  });

  test("derives the guard and stop-gate findings from the records", () => {
    expect(markdown).toContain("OMCA blocked `rm -rf /`, but `git push --force origin main` ran.");
    expect(markdown).toContain("Arms whose scripted stop was continued: omca.");
  });

  test("states no OMCA tool, hook or prompt-size count that the data does not carry", () => {
    expect(markdown).not.toMatch(/\b19 tools\b|12 of 12|27\.6 KB/);
  });

  test("skips the no-bun section when the probe was not run", () => {
    expect(markdown).not.toContain("OMCA with bun hidden");
    expect(results.omca_without_bun).toBeUndefined();
  });
});
