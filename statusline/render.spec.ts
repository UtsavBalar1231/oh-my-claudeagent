import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { displayWidth } from "../src/core/ui-kit.ts";
import { NO_REPO } from "./git.ts";
import type { GitInfo } from "./git.ts";
import {
  AGENT_GLYPHS,
  arrange,
  block,
  composePr,
  detectNerdFont,
  fixed,
  formatResetTime,
  type Payload,
  projectDirOf,
  readPlan,
  render,
  renderBar,
  type Segment,
  terminalColumns,
  terminalLines,
  visibleTruncate,
} from "./render.ts";

process.env.TZ = "UTC";

const R = "\x1b[0m";
const D = "\x1b[90m";
const C = "\x1b[36m";
const W = "\x1b[37m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const RED = "\x1b[31m";
const M = "\x1b[35m";
const B = "\x1b[34m";
const S = ` ${D}·${R} `;

const link = (url: string, text: string): string => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
const filled = (color: string, count: number): string => `${color}▰${R}`.repeat(count);
const empty = (count: number): string => `${D}▱${R}`.repeat(count);
const visible = (s: string): string => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g, "");

const ASCII = { CLAUDE_STATUSLINE_NERD_FONT: "0", COLUMNS: "300" };
const NERD = { CLAUDE_STATUSLINE_NERD_FONT: "1", COLUMNS: "300" };
const NOW = new Date("2026-10-02T12:00:00Z");
// Claude Code keeps 3 cells free on each side, so a line may be this much narrower than COLUMNS.
const INSET = 6;
const usable = (width: number): string => String(width + INSET);
const ON_BRANCH: GitInfo = { ...NO_REPO, repo: true, branch: "main" };

function lines(data: Payload, git: GitInfo = ON_BRANCH, env: Record<string, string> = ASCII): string[] {
  return render(data, git, env, NOW)
    .split("\n")
    .map((line) => {
      expect(line.endsWith(R)).toBe(true);
      return line.slice(0, -R.length);
    });
}

function one(data: Payload, git: GitInfo = NO_REPO, env: Record<string, string> = ASCII): string {
  const rendered = lines(data, git, env);
  expect(rendered).toHaveLength(1);
  return rendered[0] ?? "";
}

const BAR_10 = `${filled(G, 2)}${empty(18)} ${G}10%${R}  ${D}200k${R}`;
const WAITING = `${D}${"▱".repeat(20)}${R} ${D}[waiting...]${R}  ${D}200k${R}`;
const costClock = (cost: string, duration: string): string => `${M}${cost}${R}${S}${B}~ ${duration}${R}`;
const COST_ZERO = costClock("$0.00", "0m 0s");
const modelOf = (name: string): string => `${C}> ${name}${R}`;
const MODEL = modelOf("claude");

const withCost = (cost: NonNullable<Payload["cost"]>, context: NonNullable<Payload["context_window"]> = {}): Payload => ({
  model: { display_name: "m" },
  context_window: { context_window_size: 200000, used_percentage: 10, ...context },
  cost,
});

describe("environment", () => {
  test.each([
    [{ CLAUDE_STATUSLINE_NERD_FONT: "1" }, true],
    [{ CLAUDE_STATUSLINE_NERD_FONT: "0" }, false],
    [{ CLAUDE_STATUSLINE_NERD_FONT: " 1 " }, true],
    [{ CLAUDE_STATUSLINE_NERD_FONT: "yes" }, false],
    [{ NERD_FONT: "0" }, true],
    [{}, true],
  ])("Nerd Font preference from %o is %p", (env, expected) => {
    expect(detectNerdFont(env)).toBe(expected);
  });

  test.each([
    [{ COLUMNS: "132" }, 132],
    [{}, 80],
    [{ COLUMNS: "auto" }, 80],
    [{ COLUMNS: "0" }, 80],
    [{ COLUMNS: "" }, 80],
  ])("terminal width from %o is %p", (env, expected) => {
    expect(terminalColumns(env)).toBe(expected);
  });

  test.each([
    [{ LINES: "15" }, 15],
    [{}, null],
    [{ LINES: "auto" }, null],
    [{ LINES: "0" }, null],
    [{ LINES: "" }, null],
  ])("terminal height from %o is %p", (env, expected) => {
    expect(terminalLines(env)).toBe(expected);
  });

  test.each([
    [{ workspace: { project_dir: "/a/b" }, cwd: "/c" }, "/a/b"],
    [{ cwd: "/c" }, "/c"],
    [{ workspace: { project_dir: "" }, cwd: "/c" }, ""],
    [{}, ""],
  ] as [Payload, string][])("project directory of %o is %p", (data, expected) => {
    expect(projectDirOf(data)).toBe(expected);
  });
});

describe("rounding", () => {
  test.each([
    [72.5, 0, "72"],
    [73.5, 0, "74"],
    [2.5, 0, "2"],
    [3.5, 0, "4"],
    [-2.5, 0, "-2"],
    [0.125, 2, "0.12"],
    [0.375, 2, "0.38"],
    [1.25, 1, "1.2"],
    [2.45, 1, "2.5"],
    [1.45, 1, "1.4"],
    [1.005, 2, "1.00"],
    [2.675, 2, "2.67"],
    [999.999, 1, "1000.0"],
  ])("fixed(%p, %p) breaks only exact binary ties to even and gives %p", (x, digits, expected) => {
    expect(fixed(x, digits)).toBe(expected);
  });

  test.each([
    [0, 10, 0],
    [25, 10, 2],
    [35, 10, 4],
    [50, 10, 5],
    [100, 10, 10],
    [-10, 10, 0],
    [110, 10, 10],
    [50, 20, 10],
  ])("a bar for %p%% at width %p fills %p blocks", (pct, width, count) => {
    expect(renderBar(pct, width, G)).toBe(filled(G, count) + empty(width - count));
  });
});

describe("visible truncation", () => {
  test("escape sequences take no columns", () => {
    expect(visibleTruncate("\x1b[31mabcdef\x1b[0m", 3)).toBe(`\x1b[31mabc${R}`);
  });

  test("a hyperlink cut mid-text is closed", () => {
    const text = `${link("https://example.com", "linktext")}tail`;
    expect(visibleTruncate(text, 4)).toBe(`\x1b]8;;https://example.com\x07link\x1b]8;;\x07${R}`);
  });

  test("a hyperlink that ends before the cut is not closed twice", () => {
    expect(visibleTruncate(`${link("https://example.com", "ab")}cdef`, 3)).toBe(`${link("https://example.com", "ab")}c${R}`);
  });

  test("a short line only gains the reset", () => {
    expect(visibleTruncate("hi", 40)).toBe(`hi${R}`);
  });

  test("a narrow code point outside the BMP counts as one column and is kept whole", () => {
    expect(visibleTruncate("\u{10000}\u{10000}\u{10000}", 2)).toBe(`\u{10000}\u{10000}${R}`);
  });

  test("a wide code point counts as two columns", () => {
    expect(visibleTruncate("\u{1f600}\u{1f600}\u{1f600}", 4)).toBe(`\u{1f600}\u{1f600}${R}`);
    expect(visibleTruncate("\u{1f600}\u{1f600}", 3)).toBe(`\u{1f600}${R}`);
    expect(visibleTruncate("日本語の長いブランチ名です", 10)).toBe(`日本語の長${R}`);
    expect(displayWidth(visibleTruncate("日本語の長いブランチ名です", 9).replace(R, ""))).toBe(8);
  });

  test("a width of zero leaves nothing", () => {
    expect(visibleTruncate("abc", 0)).toBe("");
  });
});

describe("reset times", () => {
  const at = (iso: string): number => Date.parse(iso) / 1000;

  test.each([
    ["2026-10-02T18:00:00Z", "6pm"],
    ["2026-10-02T00:30:00Z", "12am"],
    ["2026-10-02T12:00:00Z", "12pm"],
    ["2026-10-05T17:00:00Z", "mon 5pm"],
    ["2026-10-03T00:00:00Z", "sat 12am"],
  ])("a reset at %s reads %p", (iso, expected) => {
    expect(formatResetTime(at(iso), NOW)).toBe(expected);
  });

  test.each([[null], [undefined], ["2026-10-02T18:00:00Z"], [1e20]] as [number | null | undefined][])("a reset of %p reads empty", (value) => {
    expect(formatResetTime(value, NOW)).toBe("");
  });
});

describe("pull request segment", () => {
  const withPr = (pr: object): Payload => ({ pr });

  test.each([[{}], [{ pr: null }], [{ pr: { url: "https://x/1", review_state: "approved" } }], [{ pr: { number: null } }]] as [Payload][])(
    "%o has no segment",
    (data) => {
      expect(composePr(data, false)).toBe("");
    },
  );

  test("a number alone is cyan text", () => {
    expect(composePr(withPr({ number: 42 }), false)).toBe(`${C}#42${R}`);
  });

  test("a url links the number", () => {
    expect(composePr(withPr({ number: 7, url: "https://github.com/o/r/pull/7" }), false)).toBe(`${C}${link("https://github.com/o/r/pull/7", "#7")}${R}`);
  });

  test.each([
    ["mr", "!"],
    ["pr", "#"],
    [undefined, "#"],
  ])("a pull request of kind %p uses the %p sigil", (kind, sigil) => {
    expect(composePr(withPr({ number: 9, kind }), false)).toBe(`${C}${sigil}9${R}`);
  });

  test.each([
    ["approved", G, "\uf00c", "+"],
    ["changes_requested", RED, "\uf00d", "!"],
    ["pending", Y, "\uf017", "?"],
    ["draft", D, "\uf040", "d"],
  ])("review state %s is %s with a Nerd Font glyph and an ASCII fallback", (state, color, nerd, ascii) => {
    const data = withPr({ number: 5, review_state: state });
    expect(composePr(data, true)).toBe(`${C}#5${R} ${color}${nerd}${R}`);
    expect(composePr(data, false)).toBe(`${C}#5${R} ${color}${ascii}${R}`);
  });

  test.each([["unknown_future_state"], ["constructor"]])("review state %s adds no glyph", (state) => {
    expect(composePr(withPr({ number: 5, review_state: state }), true)).toBe(`${C}#5${R}`);
  });
});

describe("plan segment", () => {
  let dir = "";
  const SESSION = "sess-test";
  const THREE_OF_TEN = `${[1, 2, 3].map((n) => `- [x] ${n}. Done ${n}`).join("\n")}\n${[4, 5, 6, 7, 8, 9, 10].map((n) => `- [ ] ${n}. Pending ${n}`).join("\n")}\n`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omca-statusline-plan-"));
    mkdirSync(join(dir, ".omca", "state"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function bind(plan: string | null, sessionId = SESSION): void {
    const path = join(dir, "plan.md");
    if (plan !== null) writeFileSync(path, plan);
    writeBoulder({ plans: { p: { active_plan: path } }, bindings: { [sessionId]: { plan_name: "p" } } });
  }

  const writeBoulder = (content: unknown): void =>
    writeFileSync(join(dir, ".omca", "state", "boulder.json"), typeof content === "string" ? content : JSON.stringify(content));

  const plan = (sessionId = SESSION) => readPlan(dir, sessionId);
  const rendered = (env: Record<string, string>, sessionId = SESSION): string[] =>
    lines({ model: { display_name: "m" }, session_id: sessionId, workspace: { project_dir: dir } }, NO_REPO, env);

  test("an open task gives progress and its label", () => {
    bind(THREE_OF_TEN);
    expect(plan()).toEqual({ done: 3, total: 10, label: "Pending 4" });
  });

  test("the segment reads count, arrow and label", () => {
    bind(THREE_OF_TEN);
    expect(rendered(ASCII)).toEqual([[`${C}> m${R}`, `${G}T: 3/10${R} ${D}-> Pending 4${R}`, WAITING, `${D}> ${basename(dir)}${R}`, COST_ZERO].join(S)]);
  });

  test("the Nerd Font segment uses the task glyph and a unicode arrow", () => {
    bind(THREE_OF_TEN);
    expect(rendered(NERD)[0]).toContain(`${G}\uf0ae 3/10${R} ${D}→ Pending 4${R}`);
  });

  test("a plan with nothing done counts zero", () => {
    bind("- [ ] 1. First\n- [ ] 2. Second\n");
    expect(plan()).toEqual({ done: 0, total: 2, label: "First" });
  });

  test("a task without a label gives only the count", () => {
    bind("- [x] 1. Done\n- [ ] 2.\n");
    expect(plan()).toEqual({ done: 1, total: 2, label: null });
    expect(rendered(ASCII)[0]).toContain(`${S}${G}T: 1/2${R}${S}`);
  });

  test("a label is cut to 80 characters with an ellipsis", () => {
    bind(`- [ ] 1. ${"a".repeat(100)}\n`);
    expect(plan()?.label).toBe(`${"a".repeat(79)}…`);
  });

  test.each([
    ["every task checked", "- [x] 1. First\n- [x] 2. Second\n"],
    ["only unnumbered checkboxes", "# Plan\n\n- [ ] just a note\n- [x] another note\n"],
    ["an empty plan", ""],
  ])("a bound plan with %s gives nothing", (_, text) => {
    bind(text);
    expect(plan()).toBeNull();
  });

  test("a bound plan whose file is gone gives nothing", () => {
    bind(null);
    expect(plan()).toBeNull();
  });

  test("no registry gives nothing", () => {
    expect(plan()).toBeNull();
  });

  test("an empty project directory gives nothing", () => {
    expect(readPlan("", SESSION)).toBeNull();
  });

  test("a binding for another session gives nothing even when it is the only plan", () => {
    bind(THREE_OF_TEN, "some-other-session");
    expect(plan("sess-new")).toBeNull();
    expect(rendered(ASCII, "sess-new")[0]).not.toContain("T:");
  });

  test("an empty session id gives nothing", () => {
    bind(THREE_OF_TEN);
    expect(plan("")).toBeNull();
  });

  test("a plan entry with a null path gives nothing", () => {
    writeBoulder({ plans: { p: { active_plan: null } }, bindings: { [SESSION]: { plan_name: "p" } } });
    expect(plan()).toBeNull();
  });

  test("a binding to a plan missing from the registry gives nothing", () => {
    writeBoulder({ plans: {}, bindings: { [SESSION]: { plan_name: "ghost" } } });
    expect(plan()).toBeNull();
  });

  test("an empty registry gives nothing", () => {
    writeBoulder({ plans: {}, bindings: {} });
    expect(plan()).toBeNull();
  });

  describe("shared registry schemas", () => {
    const schema = (name: string): Record<string, unknown> =>
      JSON.parse(readFileSync(join(import.meta.dir, "..", "tests", "fixtures", "boulder-schemas", `${name}.json`), "utf8"));
    const rawSchema = (name: string): string => readFileSync(join(import.meta.dir, "..", "tests", "fixtures", "boulder-schemas", `${name}.json`), "utf8");

    test("a flat registry resolves no plan", () => {
      writeFileSync(join(dir, "plan.md"), THREE_OF_TEN);
      writeBoulder({ ...schema("old-flat"), active_plan: join(dir, "plan.md") });
      expect(plan("sess-flat")).toBeNull();
    });

    test("an explicit binding picks its own plan among several", () => {
      writeFileSync(join(dir, "plan-a.md"), "- [ ] 1. First\n- [ ] 2. Second\n");
      writeFileSync(join(dir, "plan-b.md"), THREE_OF_TEN);
      const registry = schema("two-plan") as { plans: Record<string, { active_plan: string }>; bindings: Record<string, unknown> };
      registry.plans["plan-a"] = { active_plan: join(dir, "plan-a.md") };
      registry.plans["plan-b"] = { active_plan: join(dir, "plan-b.md") };
      registry.bindings["sess-bound"] = { plan_name: "plan-b", bound_at: "2026-03-01T00:00:00Z" };
      writeBoulder(registry);
      expect(plan("sess-bound")).toEqual({ done: 3, total: 10, label: "Pending 4" });
    });

    test("an unbound session among several plans gives nothing", () => {
      writeFileSync(join(dir, "plan-b.md"), THREE_OF_TEN);
      const registry = schema("two-plan") as { plans: Record<string, { active_plan: string }> };
      registry.plans["plan-b"] = { active_plan: join(dir, "plan-b.md") };
      writeBoulder(registry);
      expect(plan("sess-unbound")).toBeNull();
    });

    test.each([["corrupt"], ["half-written"]])("a %s registry gives nothing", (name) => {
      writeBoulder(rawSchema(name));
      expect(plan("sess")).toBeNull();
    });
  });
});

describe("segments", () => {
  const model = { display_name: "claude" };
  const branch = `${W}* main${R}`;

  test("a model without a name reads Claude", () => {
    expect(one({ model: {}, cost: {} })).toStartWith(`${C}> Claude${R}`);
  });

  test.each(["low", "medium", "high", "xhigh", "max"])("effort level %s follows the model", (level) => {
    expect(one({ model, effort: { level } }, ON_BRANCH)).toBe([`${C}> claude${R}${S}${Y}E: ${level}${R}`, WAITING, branch, COST_ZERO].join(S));
  });

  test("effort uses Nerd Font glyphs when enabled", () => {
    expect(one({ model, effort: { level: "high" } }, NO_REPO, NERD)).toStartWith(`${C}\uf135 claude${R}${S}${Y}\uf0e7 high${R}${S}`);
  });

  test("vim mode shows its first letter right after the model", () => {
    expect(one({ model, vim: { mode: "normal" } })).toBe([MODEL, `${Y}V: n${R}`, WAITING, COST_ZERO].join(S));
  });

  test("a worktree branch replaces the repository branch and the worktree name follows", () => {
    expect(one({ model, worktree: { name: "wt", branch: "feature/x", original_branch: "main" } }, ON_BRANCH)).toBe(
      [MODEL, WAITING, `${W}* feature/x${R}`, `${B}W: wt${R} ${D}<- main${R}`, COST_ZERO].join(S),
    );
  });

  test("a worktree without a name shows no worktree segment", () => {
    expect(one({ model, worktree: {} })).toBe([MODEL, WAITING, COST_ZERO].join(S));
  });

  test("branch counts show modified, staged and untracked in that order", () => {
    expect(one({ model }, { ...ON_BRANCH, modified: 3, staged: 2, untracked: 1 })).toBe(
      [MODEL, WAITING, `${W}* main${R} ${Y}~3${R}  ${G}+2${R}  ${D}?1${R}`, COST_ZERO].join(S),
    );
  });

  test("a repository without a branch shows none", () => {
    expect(one({ model }, { ...ON_BRANCH, branch: "" })).toBe([MODEL, WAITING, COST_ZERO].join(S));
  });

  test.each([
    ["/home/user/projects/myrepo", "myrepo"],
    ["/Users/Me/My Repo", "My Repo"],
    ["C:\\Users\\x\\proj", "proj"],
    ["C:/Users/x/proj/", "proj"],
    ["\\\\srv\\share\\proj", "proj"],
  ])("the folder segment of project %p is %p", (project_dir, name) => {
    expect(one({ model, workspace: { project_dir } }, ON_BRANCH)).toBe([MODEL, WAITING, branch, `${D}> ${name}${R}`, COST_ZERO].join(S));
  });

  test.each(["/", "C:\\", "\\\\srv\\share"])("the project root %p shows no folder segment", (project_dir) => {
    expect(one({ model, workspace: { project_dir } }, ON_BRANCH)).toBe([MODEL, WAITING, branch, COST_ZERO].join(S));
  });

  test("an SSH remote links the directory to its web address", () => {
    const git = { ...ON_BRANCH, remote: "git@github.com:user/repo.git" };
    expect(one({ model, cwd: "/work/repo" }, git)).toBe(
      [MODEL, WAITING, branch, `${D}> ${link("https://github.com/user/repo", "repo")}${R}`, COST_ZERO].join(S),
    );
  });

  test.each([
    [1, "+1 dir"],
    [2, "+2 dirs"],
  ])("%p added directories read %p and come last", (count, text) => {
    const added = Array.from({ length: count }, (_, i) => `/x${i}`);
    expect(one({ model, workspace: { added_dirs: added } })).toBe([MODEL, WAITING, COST_ZERO, `${D}${text}${R}`].join(S));
  });

  test.each([
    ["sisyphus", "A:"],
    ["oh-my-claudeagent:sisyphus", "A:"],
  ])("agent %s is marked %s without Nerd Font", (name, glyph) => {
    expect(one({ model, agent: { name } })).toBe([MODEL, WAITING, `${M}${glyph} ${name}${R}`, COST_ZERO].join(S));
  });

  test.each([
    ["sisyphus", "\uef08"],
    ["oh-my-claudeagent:executor", "\uf085"],
    ["someone-else", "\uf007"],
    ["constructor", "\uf007"],
  ])("agent %s gets glyph %p with Nerd Font", (name, glyph) => {
    expect(one({ model, agent: { name } }, NO_REPO, NERD)).toContain(`${M}${glyph} ${name}${R}`);
  });

  test("every shipped agent has its own glyph", () => {
    const shipped = readdirSync(join(import.meta.dir, "..", "agents")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -".md".length));
    expect(shipped.filter((name) => !AGENT_GLYPHS.has(name))).toEqual([]);
  });

  test("an agent without a name shows nothing", () => {
    expect(one({ model, agent: {} })).toBe([MODEL, WAITING, COST_ZERO].join(S));
  });

  test("agent, worktree and pull request come after the directory and before cost", () => {
    const data: Payload = {
      model,
      workspace: { project_dir: "/work/repo" },
      agent: { name: "sisyphus" },
      worktree: { name: "wt" },
      pr: { number: 3 },
    };
    expect(one(data, ON_BRANCH)).toBe([MODEL, WAITING, branch, `${D}> repo${R}`, `${M}A: sisyphus${R}`, `${B}W: wt${R}`, `${C}#3${R}`, COST_ZERO].join(S));
  });

  test("a payload without a repository shows no pull request segment", () => {
    expect(one({ model, pr: { url: "https://x/1" } })).toBe([MODEL, WAITING, COST_ZERO].join(S));
  });

  test("the cut segments are never drawn", () => {
    const withCut: Payload = JSON.parse(
      JSON.stringify({
        model,
        session_id: "abcdef1234567890",
        session_name: "my-session",
        transcript_path: "/tmp/s.jsonl",
        version: "2.1.287",
        thinking: { enabled: true },
        output_style: { name: "compact" },
        workspace: { repo: { host: "github.com", owner: "acme", name: "app" } },
        context_window: { total_input_tokens: 15000, total_output_tokens: 1200, used_percentage: 10 },
        cost: { total_api_duration_ms: 23456 },
      }),
    );
    const plain: Payload = { model, context_window: { used_percentage: 10 }, cost: {} };
    expect(lines(withCut)).toEqual(lines(plain));
    const text = visible(lines(withCut).join("\n"));
    for (const gone of ["[T]", "abcdef12", "my-session", "2.1.287", "DEGRADED", "omca-setup", "tok", "api ", "acme"]) expect(text).not.toContain(gone);
  });
});

describe("metrics segments", () => {
  const metrics = (data: Payload): string => one(data, NO_REPO);
  const MODEL_M = modelOf("m");

  test.each([
    [{ total_cost_usd: 1.23 }, "$1.23"],
    [{}, "$0.00"],
    [{ total_cost_usd: 0.125 }, "$0.12"],
  ])("cost %o reads %s", (cost, text) => {
    expect(metrics(withCost(cost))).toBe([MODEL_M, BAR_10, costClock(text, "0m 0s")].join(S));
  });

  test.each([
    [0, "0m 0s"],
    [999, "0m 0s"],
    [61000, "1m 1s"],
    [90000, "1m 30s"],
    [3600000, "60m 0s"],
  ])("a duration of %p ms reads %s", (ms, text) => {
    expect(metrics(withCost({ total_duration_ms: ms }))).toBe([MODEL_M, BAR_10, costClock("$0.00", text)].join(S));
  });

  test.each([
    [{ total_lines_added: 42, total_lines_removed: 17 }, `${G}+42${R}/${RED}-17${R}`],
    [{ total_lines_added: 42 }, `${G}+42${R}`],
    [{ total_lines_removed: 17 }, `${RED}-17${R}`],
  ])("changed lines %o read %s", (cost, text) => {
    expect(metrics(withCost(cost))).toBe([MODEL_M, BAR_10, COST_ZERO, text].join(S));
  });

  test("zero changed lines are left out", () => {
    expect(metrics(withCost({ total_lines_added: 0, total_lines_removed: 0 }))).toBe([MODEL_M, BAR_10, COST_ZERO].join(S));
  });
});

describe("usage limits", () => {
  const model = { display_name: "claude" };
  const window = (pct: number, glyph: string, reset: string, color = G, blocks = Math.round(pct / 10)): string =>
    `${filled(color, blocks)}${empty(10 - blocks)} ${color}${pct}%${R} ${D}${glyph}${R}${reset}`;
  const base = [MODEL, WAITING, COST_ZERO];

  test("each window is its own segment after cost, five hours first", () => {
    const data: Payload = {
      model,
      rate_limits: {
        five_hour: { used_percentage: 45, resets_at: Date.parse("2026-10-02T18:00:00Z") / 1000 },
        seven_day: { used_percentage: 80, resets_at: Date.parse("2026-10-05T17:00:00Z") / 1000 },
      },
    };
    expect(one(data)).toBe([...base, window(45, "5h", " (resets 6pm)", G, 4), window(80, "7d", " (resets mon 5pm)", Y)].join(S));
  });

  test("a window with no readable reset time is left bare", () => {
    expect(one({ model, rate_limits: { five_hour: { used_percentage: 45, resets_at: null } } })).toBe([...base, window(45, "5h", "", G, 4)].join(S));
  });

  test("a window without a percentage is skipped", () => {
    expect(one({ model, rate_limits: { five_hour: { resets_at: 1 }, seven_day: { used_percentage: 60 } } })).toBe([...base, window(60, "7d", "", Y)].join(S));
  });

  test("a window is coloured by the same thresholds as the context bar", () => {
    const text = one({ model, rate_limits: { five_hour: { used_percentage: 91 } } });
    expect(text).toContain(`${RED}91%${R}`);
  });
});

describe("context bar", () => {
  const bar = (context: NonNullable<Payload["context_window"]>, exceeds = false): string =>
    one({ model: { display_name: "m" }, context_window: context, exceeds_200k_tokens: exceeds, cost: {} }).split(S)[1] ?? "";
  const label = (size: string): string => `${D}${size}${R}`;

  test("the used percentage is drawn and the window labelled", () => {
    expect(bar({ context_window_size: 200000, used_percentage: 50 })).toBe(`${filled(G, 10)}${empty(10)} ${G}50%${R}  ${label("200k")}`);
  });

  test("a million-token window is labelled 1M", () => {
    expect(bar({ context_window_size: 1000000, used_percentage: 10 })).toBe(`${filled(G, 2)}${empty(18)} ${G}10%${R}  ${label("1M")}`);
  });

  test("a missing window size reads 200k", () => {
    expect(bar({ used_percentage: 10 })).toBe(`${filled(G, 2)}${empty(18)} ${G}10%${R}  ${label("200k")}`);
  });

  test("current usage fills the bar when no percentage is given", () => {
    const usage = { input_tokens: 100000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    expect(bar({ context_window_size: 200000, current_usage: usage })).toBe(`${filled(G, 10)}${empty(10)} ${G}50%${R}  ${label("200k")}`);
  });

  test("remaining percentage stands in for the used percentage", () => {
    expect(bar({ context_window_size: 200000, remaining_percentage: 92 })).toBe(`${filled(G, 2)}${empty(18)} ${G}8%${R}  ${label("200k")}`);
  });

  test("no remaining percentage means a full context", () => {
    expect(bar({ context_window_size: 200000, remaining_percentage: 0 })).toBe(`${filled(RED, 20)} ${RED}100%${R}  ${label("200k")}`);
  });

  test("the used percentage wins over the remaining percentage", () => {
    expect(bar({ context_window_size: 200000, used_percentage: 50, remaining_percentage: 70 })).toBe(
      `${filled(G, 10)}${empty(10)} ${G}50%${R}  ${label("200k")}`,
    );
  });

  test("no data shows the waiting placeholder", () => {
    expect(bar({ context_window_size: 200000 })).toBe(`${D}${"▱".repeat(20)}${R} ${D}[waiting...]${R}  ${label("200k")}`);
  });

  test("a bar halfway between two blocks rounds to the even block", () => {
    expect(bar({ context_window_size: 200000, used_percentage: 72.5 })).toBe(`${filled(Y, 14)}${empty(6)} ${Y}72%${R}  ${label("200k")}`);
  });

  test("a window past 200k tokens is flagged only when the window is 200k", () => {
    expect(bar({ context_window_size: 200000, used_percentage: 90 }, true)).toBe(`${filled(RED, 18)}${empty(2)} ${RED}90%${R} ${RED}\x1b[1m!${R}  ${label("200k")}`);
    expect(bar({ context_window_size: 1000000, used_percentage: 90 }, true)).toBe(`${filled(RED, 18)}${empty(2)} ${RED}90%${R}  ${label("1M")}`);
  });

  test.each([
    [0, G, "0"],
    [59.9, G, "60"],
    [60, Y, "60"],
    [84.9, Y, "85"],
    [85, RED, "85"],
    [100, RED, "100"],
  ])("%p%% is coloured by its unrounded value", (pct, color, text) => {
    expect(bar({ context_window_size: 200000, used_percentage: pct })).toContain(` ${color}${text}%${R}  `);
  });

  describe("width follows the free space on its line", () => {
    const wide = (columns: number): string =>
      one({ model: { display_name: "m" }, context_window: { context_window_size: 200000, used_percentage: 10 } }, NO_REPO, { ...ASCII, COLUMNS: String(columns) });
    const blocks = (line: string): number => (visible(line).match(/[▰▱]/g) ?? []).length;

    test("a full line leaves the bar at 8 blocks", () => {
      const line = lines({ model: { display_name: "x".repeat(37) }, context_window: { context_window_size: 200000, used_percentage: 10 }, cost: {} }, NO_REPO, {
        ...ASCII,
        COLUMNS: usable(60),
      });
      expect(line).toHaveLength(2);
      expect(blocks(line[0] ?? "")).toBe(8);
      expect(displayWidth(visible(line[0] ?? ""))).toBe(60);
    });

    test("spare cells go to the bar", () => {
      const line = lines({ model: { display_name: "x".repeat(27) }, context_window: { context_window_size: 200000, used_percentage: 10 }, cost: {} }, NO_REPO, {
        ...ASCII,
        COLUMNS: usable(60),
      });
      expect(blocks(line[0] ?? "")).toBe(18);
      expect(displayWidth(visible(line[0] ?? ""))).toBe(60);
    });

    test("a roomy line stops at 20 blocks", () => {
      expect(blocks(wide(200))).toBe(20);
    });

    test("the waiting placeholder follows the same width", () => {
      const line = lines({ model: { display_name: "x".repeat(28) }, context_window: { context_window_size: 200000 }, cost: {} }, NO_REPO, { ...ASCII, COLUMNS: usable(60) });
      expect(blocks(line[0] ?? "")).toBe(8);
      expect(displayWidth(visible(line[0] ?? ""))).toBe(60);
    });
  });
});

describe("arrange", () => {
  const text = (s: string): string => visible(s).replace(/ · /g, "|");
  const sep = (s: string): string => text(s).replace(/\x1b\[0m$/, "");
  const arranged = (segments: readonly Segment[], columns: number, maxLines: number): string[] => arrange(segments, columns, maxLines).map(sep);
  const grower = (min: number, max: number): Segment => ({ min, max, grows: true, draw: (w) => "g".repeat(w) });
  const A = block("aaaa");
  const B2 = block("bbbb");
  const C2 = block("cccc");

  test("segments fill a line in order, three cells apart", () => {
    expect(arranged([A, B2], 11, 4)).toEqual(["aaaa|bbbb"]);
  });

  test("a segment that does not fit wraps whole to the next line", () => {
    expect(arranged([A, B2, C2], 11, 4)).toEqual(["aaaa|bbbb", "cccc"]);
    expect(arranged([A, B2, C2], 10, 4)).toEqual(["aaaa", "bbbb", "cccc"]);
  });

  test("a line later in the order does not take a segment a higher one was refused", () => {
    expect(arranged([A, block("bbbbbbbb"), block("c")], 10, 4)).toEqual(["aaaa", "bbbbbbbb", "c"]);
  });

  test("when the lines run out, the segment and every lower one are dropped", () => {
    expect(arranged([A, B2, C2, block("d")], 11, 1)).toEqual(["aaaa|bbbb"]);
    expect(arranged([A, B2, C2, block("d")], 11, 2)).toEqual(["aaaa|bbbb", "cccc|d"]);
    expect(arranged([A, B2, block("cccccccccc"), block("d")], 11, 2)).toEqual(["aaaa|bbbb", "cccccccccc"]);
  });

  test("a segment wider than the terminal is skipped and the rest go on", () => {
    expect(arranged([A, block("x".repeat(30)), B2], 11, 4)).toEqual(["aaaa|bbbb"]);
  });

  test("a first segment wider than the terminal is cut to it", () => {
    const [line] = arrange([block("x".repeat(30)), A], 10, 4);
    expect(line).toBe(`${"x".repeat(10)}${R}`);
  });

  test("a growing segment takes the free cells up to its maximum", () => {
    expect(arranged([A, grower(3, 10), B2], 30, 1)).toEqual(["aaaa|gggggggggg|bbbb"]);
    expect(arranged([A, grower(3, 10), B2], 20, 1)).toEqual(["aaaa|gggggg|bbbb"]);
    expect(arranged([A, grower(3, 10)], 40, 1)).toEqual(["aaaa|gggggggggg"]);
  });

  test("a growing segment sits at its minimum when the line is full", () => {
    expect(arranged([A, grower(3, 10), B2], 17, 1)).toEqual(["aaaa|ggg|bbbb"]);
  });

  test("a growing segment takes the cells a wrapped neighbour left behind", () => {
    expect(arranged([A, grower(3, 10), B2], 12, 4)).toEqual(["aaaa|ggggg", "bbbb"]);
  });
});

describe("layout", () => {
  const model = { display_name: "claude" };
  const SESSION = "layout-session";
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omca-statusline-layout-"));
    mkdirSync(join(dir, ".omca", "state"), { recursive: true });
    writeFileSync(join(dir, "plan.md"), "- [x] 1. Done\n- [ ] 2. Wire the order summary panel into the payment step and cover it with a test\n- [ ] 3. Later\n");
    writeFileSync(
      join(dir, ".omca", "state", "boulder.json"),
      JSON.stringify({ plans: { p: { active_plan: join(dir, "plan.md") } }, bindings: { [SESSION]: { plan_name: "p" } } }),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const rich = (): Payload => ({
    model: { display_name: "Opus 5.5" },
    session_id: SESSION,
    workspace: { project_dir: dir, added_dirs: ["/a", "/b"] },
    effort: { level: "high" },
    agent: { name: "oh-my-claudeagent:sisyphus" },
    worktree: { name: "wt", original_branch: "main" },
    pr: { number: 42, url: "https://github.com/acme/app/pull/42", review_state: "approved" },
    context_window: { context_window_size: 200000, used_percentage: 34 },
    cost: { total_cost_usd: 1.5, total_duration_ms: 125000, total_lines_added: 42, total_lines_removed: 7 },
    rate_limits: { five_hour: { used_percentage: 45, resets_at: Date.parse("2026-10-02T18:00:00Z") / 1000 }, seven_day: { used_percentage: 80, resets_at: Date.parse("2026-10-05T17:00:00Z") / 1000 } },
  });
  const richGit: GitInfo = { ...ON_BRANCH, branch: "v3-typescript-mods", staged: 2, modified: 3, untracked: 1, remote: "git@github.com:acme/app.git" };
  const at = (columns: number, rows?: number): string[] =>
    lines(rich(), richGit, { ...ASCII, COLUMNS: String(columns), ...(rows === undefined ? {} : { LINES: String(rows) }) });

  test("a terminal narrower than 60 columns gets one compact line: model, plan count, context percentage, branch", () => {
    expect(at(59).map(visible)).toEqual(["> Opus 5.5 · T: 1/3 · 34% · * v3-typescript-mods"]);
  });

  test("the compact line drops its lowest segments first when they do not fit", () => {
    expect(at(40).map(visible)).toEqual(["> Opus 5.5 · T: 1/3 · 34%"]);
    expect(at(16).map(visible)).toEqual(["> Opus 5.5"]);
  });

  test("the compact context percentage uses the colour thresholds", () => {
    const data = { ...rich(), context_window: { context_window_size: 200000, used_percentage: 90 } };
    expect(lines(data, richGit, { ...ASCII, COLUMNS: "50" })[0]).toContain(` ${RED}90%${R}`);
  });

  test("a terminal of 60 columns gets the full layout", () => {
    expect(at(60).length).toBeGreaterThan(1);
    expect(at(60)[0]).toContain("E: high");
  });

  test("a line takes at most the columns left after the 3 cells Claude Code keeps free on each side", () => {
    const widths = at(80).map((line) => displayWidth(visible(line)));
    expect(Math.max(...widths)).toBe(74);
  });

  test("a height under 20 allows two lines, 20 and above four", () => {
    expect(at(80, 19)).toHaveLength(2);
    expect(at(80, 20)).toHaveLength(4);
    expect(at(80)).toHaveLength(4);
  });

  test("the short layout keeps the first two lines of the tall one", () => {
    expect(at(80, 15)).toEqual(at(80).slice(0, 2));
  });

  test("only the next-task label is ellipsized, to the room its line has", () => {
    const [first] = at(60).map(visible);
    expect(first).toBe("> Opus 5.5 · E: high · T: 1/3 -> Wire the order summa…");
    expect(displayWidth(first ?? "")).toBe(54);
  });

  test("a wide terminal shows the whole label", () => {
    expect(at(200).map(visible)[0]).toContain("-> Wire the order summary panel into the payment step and cover it with a test ·");
  });

  test("the label wraps with its segment instead of being squeezed under 12 cells", () => {
    const data: Payload = { ...rich(), model: { display_name: "x".repeat(28) } };
    const [first, second] = lines(data, richGit, { ...ASCII, COLUMNS: usable(60) }).map(visible);
    expect(first).toBe(`> ${"x".repeat(28)} · E: high`);
    expect(second).toStartWith("T: 1/3 -> Wire the order summary panel");
  });

  test("every line fits the columns left after the margins, at every width and height, counting wide characters as two", () => {
    const data: Payload = { ...rich(), model: { display_name: "日本語モデル" } };
    const git = { ...richGit, branch: "機能/日本語ブランチ" };
    for (let columns = 1; columns <= 260; columns++) {
      for (const rows of [undefined, 15, 40]) {
        const env = { ...ASCII, COLUMNS: String(columns), ...(rows === undefined ? {} : { LINES: String(rows) }) };
        for (const line of lines(data, git, env)) expect(displayWidth(visible(line))).toBeLessThanOrEqual(Math.max(1, columns - INSET));
      }
    }
  });

  test("a segment that cannot fit even a line of its own is dropped, not cut", () => {
    const data: Payload = { ...rich(), worktree: { branch: "b".repeat(80) } };
    expect(lines(data, richGit, { ...ASCII, COLUMNS: "70" }).map(visible).join("\n")).not.toContain("bbb");
  });

  test("the model leads the first line even when it alone is wider than the terminal", () => {
    expect(lines({ model: { display_name: "M".repeat(80) } }, NO_REPO, { ...ASCII, COLUMNS: usable(30) }).map(visible)).toEqual([`> ${"M".repeat(28)}`]);
  });

  test("links are closed whole at every width", () => {
    for (let columns = 60; columns <= 220; columns++) {
      for (const line of lines(rich(), richGit, { ...ASCII, COLUMNS: String(columns) })) {
        const opens = (line.match(/\x1b\]8;;[^\x07]+\x07/g) ?? []).length;
        const closes = (line.match(/\x1b\]8;;\x07/g) ?? []).length;
        expect(closes).toBe(opens);
      }
    }
  });

  test("the subagent count file is not read", () => {
    const data: Payload = { model, workspace: { project_dir: dir } };
    const before = lines(data);
    writeFileSync(join(dir, ".omca", "state", "subagent-models.json"), JSON.stringify({ a1: { model: "Sonnet" }, a2: { model: "Opus" } }));
    expect(lines(data)).toEqual(before);
  });
});
