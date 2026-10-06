import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { AGENT_ICONS, displayWidth, type GlyphTier } from "../src/core/ui-kit.ts";
import { NO_REPO } from "./git.ts";
import type { GitInfo } from "./git.ts";
import {
  arrange,
  block,
  composePr,
  DEFAULT_MAIN_AGENT,
  fixed,
  formatResetTime,
  type Payload,
  projectDirOf,
  readPlan,
  render,
  renderBar,
  type Segment,
  stackRows,
  statusGlyphs,
  type Ranked,
  terminalColumns,
  terminalLines,
  visibleTruncate,
} from "./render.ts";

process.env.TZ = "UTC";

const R = "\x1b[0m";
const D = "\x1b[90m";
const C = "\x1b[36m";
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

const ASCII = { OMCA_GLYPHS: "unicode", COLUMNS: "300" };
const NERD = { OMCA_GLYPHS: "nerd", COLUMNS: "300" };
const PLAIN = { OMCA_GLYPHS: "ascii", COLUMNS: "300" };
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

const rows = (data: Payload, git: GitInfo = NO_REPO, env: Record<string, string> = ASCII): string[] => lines(data, git, env);

const BAR_10 = `${filled(G, 2)}${empty(18)} ${G}10%${R}  ${D}200k${R}`;
const WAITING = `${D}${"▱".repeat(20)}${R} ${D}[waiting...]${R}  ${D}200k${R}`;
const clock = (duration: string): string => `${B}~ ${duration}${R}`;
const costClock = (cost: string, duration: string): string => `${M}${cost}${R}${S}${clock(duration)}`;
const ZERO = clock("0s");
const modelOf = (name: string): string => `${C}> ${name}${R}`;
const MODEL = modelOf("claude");

const withCost = (cost: NonNullable<Payload["cost"]>, context: NonNullable<Payload["context_window"]> = {}): Payload => ({
  model: { display_name: "m" },
  context_window: { context_window_size: 200000, used_percentage: 10, ...context },
  cost,
});

describe("environment", () => {
  test.each<[Record<string, string>, GlyphTier]>([
    [{ OMCA_GLYPHS: "nerd" }, "nerd"],
    [{ OMCA_GLYPHS: " Unicode " }, "unicode"],
    [{ OMCA_GLYPHS: "ascii" }, "ascii"],
    [{ OMCA_GLYPHS: "0" }, "nerd"],
    [{ CLAUDE_STATUSLINE_NERD_FONT: "0" }, "nerd"],
    [{}, "nerd"],
  ])("the glyph tier from %o is %p", (env, expected) => {
    expect(statusGlyphs(env).tier).toBe(expected);
  });

  test("the ascii tier draws plain text throughout: # and . bars, | between segments", () => {
    const data = withCost({ total_cost_usd: 1.5, total_duration_ms: 125_000 });
    const drawn = rows({ ...data, rate_limits: { five_hour: { used_percentage: 45 } } }, ON_BRANCH, PLAIN).map(visible);
    expect(drawn.filter((line) => !/^[\x20-\x7e]*$/.test(line))).toEqual([]);
    expect(drawn.join("\n")).toContain("##.................. 10%");
    expect(drawn.join("\n")).toContain(" | ");
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
      expect(composePr(data, "unicode")).toBe("");
    },
  );

  test("a number alone is cyan text", () => {
    expect(composePr(withPr({ number: 42 }), "unicode")).toBe(`${C}#42${R}`);
  });

  test("a url links the number", () => {
    expect(composePr(withPr({ number: 7, url: "https://github.com/o/r/pull/7" }), "unicode")).toBe(`${C}${link("https://github.com/o/r/pull/7", "#7")}${R}`);
  });

  test.each([
    ["mr", "!"],
    ["pr", "#"],
    [undefined, "#"],
  ])("a pull request of kind %p uses the %p sigil", (kind, sigil) => {
    expect(composePr(withPr({ number: 9, kind }), "unicode")).toBe(`${C}${sigil}9${R}`);
  });

  test.each([
    ["approved", G, "\uf00c", "+"],
    ["changes_requested", RED, "\uf00d", "!"],
    ["pending", Y, "\uf017", "?"],
    ["draft", D, "\uf040", "d"],
  ])("review state %s is %s with a Nerd Font glyph and an ASCII fallback", (state, color, nerd, ascii) => {
    const data = withPr({ number: 5, review_state: state });
    expect(composePr(data, "nerd")).toBe(`${C}#5${R} ${color}${nerd}${R}`);
    expect(composePr(data, "unicode")).toBe(`${C}#5${R} ${color}${ascii}${R}`);
  });

  test.each([["unknown_future_state"], ["constructor"]])("review state %s adds no glyph", (state) => {
    expect(composePr(withPr({ number: 5, review_state: state }), "nerd")).toBe(`${C}#5${R}`);
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
    expect(rendered(ASCII)).toEqual([[`${C}> m${R}`, `${G}T: 3/10${R} ${D}-> Pending 4${R}`].join(S), [WAITING, `${D}> ${basename(dir)}${R}`].join(S), ZERO]);
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
    expect(rendered(ASCII)[0]).toBe([`${C}> m${R}`, `${G}T: 1/2${R}`].join(S));
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
  const branch = "* main";

  test("a model without a name reads Claude", () => {
    expect(rows({ model: {}, cost: {} })[0]).toBe(`${C}> Claude${R}`);
  });

  test.each(["low", "medium", "high", "xhigh", "max"])("effort level %s follows the model", (level) => {
    expect(rows({ model, effort: { level } }, ON_BRANCH)).toEqual([`${C}> claude${R}${S}${Y}E: ${level}${R}`, [WAITING, branch].join(S), ZERO]);
  });

  test("effort uses Nerd Font glyphs when enabled", () => {
    expect(rows({ model, effort: { level: "high" } }, NO_REPO, NERD)[0]).toBe(`${C}\uf135 claude${R}${S}${Y}\uf0e7 high${R}`);
  });

  test("vim mode shows its first letter right after the model", () => {
    expect(rows({ model, vim: { mode: "normal" } })).toEqual([[MODEL, `${Y}V: n${R}`].join(S), WAITING, ZERO]);
  });

  test("a worktree branch replaces the repository branch and the worktree name follows", () => {
    expect(rows({ model, worktree: { name: "wt", branch: "feature/x", original_branch: "main" } }, ON_BRANCH)).toEqual([
      MODEL,
      [WAITING, "* feature/x", `${B}W: wt${R} ${D}<- main${R}`].join(S),
      ZERO,
    ]);
  });

  test("a worktree without a name shows no worktree segment", () => {
    expect(rows({ model, worktree: {} })).toEqual([MODEL, WAITING, ZERO]);
  });

  test("branch counts show modified, staged and untracked in that order", () => {
    expect(rows({ model }, { ...ON_BRANCH, modified: 3, staged: 2, untracked: 1 })).toEqual([
      MODEL,
      [WAITING, `* main ${Y}~3${R}  ${G}+2${R}  ${D}?1${R}`].join(S),
      ZERO,
    ]);
  });

  test("a repository without a branch shows none", () => {
    expect(rows({ model }, { ...ON_BRANCH, branch: "" })).toEqual([MODEL, WAITING, ZERO]);
  });

  test.each([
    ["/home/user/projects/myrepo", "myrepo"],
    ["/Users/Me/My Repo", "My Repo"],
    ["C:\\Users\\x\\proj", "proj"],
    ["C:/Users/x/proj/", "proj"],
    ["\\\\srv\\share\\proj", "proj"],
  ])("the folder segment of project %p is %p", (project_dir, name) => {
    expect(rows({ model, workspace: { project_dir } }, ON_BRANCH)).toEqual([MODEL, [WAITING, branch, `${D}> ${name}${R}`].join(S), ZERO]);
  });

  test.each(["/", "C:\\", "\\\\srv\\share"])("the project root %p shows no folder segment", (project_dir) => {
    expect(rows({ model, workspace: { project_dir } }, ON_BRANCH)).toEqual([MODEL, [WAITING, branch].join(S), ZERO]);
  });

  test("an SSH remote links the directory to its web address", () => {
    const git = { ...ON_BRANCH, remote: "git@github.com:user/repo.git" };
    expect(rows({ model, cwd: "/work/repo" }, git)).toEqual([
      MODEL,
      [WAITING, branch, `${D}> ${link("https://github.com/user/repo", "repo")}${R}`].join(S),
      ZERO,
    ]);
  });

  test.each([
    [1, "+1 dir"],
    [2, "+2 dirs"],
  ])("%p added directories read %p and end the workspace row", (count, text) => {
    const added = Array.from({ length: count }, (_, i) => `/x${i}`);
    expect(rows({ model, workspace: { added_dirs: added } })).toEqual([MODEL, [WAITING, `${D}${text}${R}`].join(S), ZERO]);
  });

  test.each([
    ["orchestrator", "A:"],
    ["oh-my-claudeagent:planner", "A:"],
  ])("agent %s is marked %s without Nerd Font", (name, glyph) => {
    expect(rows({ model, agent: { name } })).toEqual([[MODEL, `${M}${glyph} ${name}${R}`].join(S), WAITING, ZERO]);
  });

  test.each([
    ["orchestrator", "\uf001"],
    ["oh-my-claudeagent:executor", "\uf085"],
    ["someone-else", "\uf007"],
    ["constructor", "\uf007"],
  ])("agent %s gets glyph %p with Nerd Font", (name, glyph) => {
    expect(rows({ model, agent: { name } }, NO_REPO, NERD)[0]).toEndWith(`${M}${glyph} ${name}${R}`);
  });

  test("every shipped agent has its own glyph", () => {
    const shipped = readdirSync(join(import.meta.dir, "..", "agents")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -".md".length));
    expect(shipped.filter((name) => !Object.hasOwn(AGENT_ICONS, name))).toEqual([]);
  });

  test("the plugin's default main agent shows nothing, and that default is the one settings.json sets", () => {
    expect(rows({ model, agent: { name: DEFAULT_MAIN_AGENT } })).toEqual([MODEL, WAITING, ZERO]);
    expect(JSON.parse(readFileSync(join(import.meta.dir, "..", "settings.json"), "utf8")).agent).toBe(DEFAULT_MAIN_AGENT);
  });

  test("an agent without a name shows nothing", () => {
    expect(rows({ model, agent: {} })).toEqual([MODEL, WAITING, ZERO]);
  });

  test("the agent follows the model, and worktree and pull request follow the directory", () => {
    const data: Payload = {
      model,
      workspace: { project_dir: "/work/repo" },
      agent: { name: "orchestrator" },
      worktree: { name: "wt" },
      pr: { number: 3 },
    };
    expect(rows(data, ON_BRANCH)).toEqual([[MODEL, `${M}A: orchestrator${R}`].join(S), [WAITING, branch, `${D}> repo${R}`, `${B}W: wt${R}`, `${C}#3${R}`].join(S), ZERO]);
  });

  test("a payload without a repository shows no pull request segment", () => {
    expect(rows({ model, pr: { url: "https://x/1" } })).toEqual([MODEL, WAITING, ZERO]);
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
  });
});

describe("metrics segments", () => {
  const metrics = (data: Payload): string[] => rows(data);
  const MODEL_M = modelOf("m");

  test.each([
    [{ total_cost_usd: 1.23 }, "$1.23"],
    [{ total_cost_usd: 0.125 }, "$0.12"],
  ])("cost %o reads %s before the duration", (cost, text) => {
    expect(metrics(withCost(cost))).toEqual([MODEL_M, BAR_10, costClock(text, "0s")]);
  });

  test.each([
    [0, "0s"],
    [999, "0s"],
    [61000, "1m01s"],
    [90000, "1m30s"],
    [3600000, "1h00m"],
  ])("a duration of %p ms reads %s", (ms, text) => {
    expect(metrics(withCost({ total_duration_ms: ms }))).toEqual([MODEL_M, BAR_10, clock(text)]);
  });

  test.each([
    [{ total_lines_added: 42, total_lines_removed: 17 }, `${G}+42${R}/${RED}-17${R}`],
    [{ total_lines_added: 42 }, `${G}+42${R}`],
    [{ total_lines_removed: 17 }, `${RED}-17${R}`],
  ])("changed lines %o read %s", (cost, text) => {
    expect(metrics(withCost(cost))).toEqual([MODEL_M, [BAR_10, text].join(S), ZERO]);
  });

  test("zero changed lines are left out", () => {
    expect(metrics(withCost({ total_lines_added: 0, total_lines_removed: 0 }))).toEqual([MODEL_M, BAR_10, ZERO]);
  });
});

describe("cost by account", () => {
  const FIVE_HOUR = { used_percentage: 45 };
  const at = (cost: number | undefined, limits?: Payload["rate_limits"]): string =>
    rows({ ...withCost({ total_duration_ms: 125000, ...(cost === undefined ? {} : { total_cost_usd: cost }) }), ...(limits === undefined ? {} : { rate_limits: limits }) })[2] ?? "";

  test("an API account sees its cost before the duration", () => {
    expect(at(1.5)).toBe(costClock("$1.50", "2m05s"));
    expect(at(1.5, null)).toBe(costClock("$1.50", "2m05s"));
    expect(at(1.5, {})).toBe(costClock("$1.50", "2m05s"));
  });

  test.each([
    ["five_hour", { five_hour: FIVE_HOUR }],
    ["seven_day", { seven_day: FIVE_HOUR }],
    ["five_hour without a reading", { five_hour: { resets_at: 1 } }],
    ["seven_day beside a spend_limit", { seven_day: FIVE_HOUR, spend_limit: { used_usd: 1, limit_usd: 10 } }],
  ] as [string, Payload["rate_limits"]][])("a subscription window (%s) hides the cost and keeps the duration", (_, limits) => {
    expect(at(1.5, limits)).toStartWith(clock("2m05s"));
    expect(visible(at(1.5, limits))).not.toContain("$1.50");
  });

  test("a gateway that reports only a spend limit bills by spend and keeps the cost", () => {
    expect(at(1.5, { spend_limit: { used_usd: 1, limit_usd: 10 } })).toBe([costClock("$1.50", "2m05s"), `${G}S: $1.00/$10${R}`].join(S));
  });

  test.each([[0], [undefined]])("a cost of %p, as before the first response, is hidden", (cost) => {
    expect(at(cost)).toBe(clock("2m05s"));
  });
});

describe("usage limits", () => {
  const model = { display_name: "claude" };
  const window = (pct: number, glyph: string, reset: string, color = G, blocks = Math.round(pct / 10)): string =>
    `${filled(color, blocks)}${empty(10 - blocks)} ${color}${pct}%${R} ${D}${glyph}${R}${reset}`;
  const usage = (...segments: string[]): string[] => [MODEL, WAITING, [ZERO, ...segments].join(S)];

  test("each window is its own segment after the duration, five hours first", () => {
    const data: Payload = {
      model,
      rate_limits: {
        five_hour: { used_percentage: 45, resets_at: Date.parse("2026-10-02T18:00:00Z") / 1000 },
        seven_day: { used_percentage: 80, resets_at: Date.parse("2026-10-05T17:00:00Z") / 1000 },
      },
    };
    expect(rows(data)).toEqual(usage(window(45, "5h", " (resets 6pm)", G, 4), window(80, "7d", " (resets mon 5pm)", Y)));
  });

  test("a window with no readable reset time is left bare", () => {
    expect(rows({ model, rate_limits: { five_hour: { used_percentage: 45, resets_at: null } } })).toEqual(usage(window(45, "5h", "", G, 4)));
  });

  test("a window without a percentage is skipped", () => {
    expect(rows({ model, rate_limits: { five_hour: { resets_at: 1 }, seven_day: { used_percentage: 60 } } })).toEqual(usage(window(60, "7d", "", Y)));
  });

  test("a window is coloured by the same thresholds as the context bar", () => {
    expect(rows({ model, rate_limits: { five_hour: { used_percentage: 91 } } })[2]).toContain(`${RED}91%${R}`);
  });
});

describe("spend limit", () => {
  const model = { display_name: "claude" };
  const base = [MODEL, WAITING, ZERO];
  const spend = (limit: NonNullable<NonNullable<Payload["rate_limits"]>["spend_limit"]>): Payload => ({ model, rate_limits: { spend_limit: limit } });

  test("dollars spent and the limit follow the duration, with the period, in ASCII and in Nerd Font glyphs", () => {
    const data = spend({ used_percentage: 62.8, used_usd: 314.12, limit_usd: 500, period: "monthly" });
    expect(rows(data)).toEqual([MODEL, WAITING, [ZERO, `${Y}S: $314.12/$500${R} ${D}mo${R}`].join(S)]);
    expect(rows(data, NO_REPO, NERD)[2]).toEndWith(`${Y}\uf0d6 $314.12/$500${R} ${D}mo${R}`);
  });

  test("each period reads as its short word, and an unknown or absent period leaves none", () => {
    const label = (period: string | null | undefined): string =>
      rows(spend({ used_percentage: 10, used_usd: 1, limit_usd: 10, ...(period === undefined ? {} : { period }) })).at(-1)?.split(S).at(-1) ?? "";
    expect(label("daily")).toBe(`${G}S: $1.00/$10${R} ${D}day${R}`);
    expect(label("weekly")).toBe(`${G}S: $1.00/$10${R} ${D}wk${R}`);
    expect(label("monthly")).toBe(`${G}S: $1.00/$10${R} ${D}mo${R}`);
    expect(label("quarterly")).toBe(`${G}S: $1.00/$10${R}`);
    expect(label(null)).toBe(`${G}S: $1.00/$10${R}`);
    expect(label(undefined)).toBe(`${G}S: $1.00/$10${R}`);
  });

  test("a limit with cents keeps them, and the colour comes from the dollars when no percentage came", () => {
    expect(rows(spend({ used_usd: 90, limit_usd: 100.5 }))[2]).toEndWith(`${RED}S: $90.00/$100.50${R}`);
    expect(rows(spend({ used_usd: 61, limit_usd: 100 }))[2]).toEndWith(`${Y}S: $61.00/$100${R}`);
    expect(rows(spend({ used_usd: 5, limit_usd: 0 }))[2]).toEndWith(`${G}S: $5.00/$0${R}`);
  });

  test("the reported percentage colours the segment when both are present", () => {
    expect(rows(spend({ used_percentage: 120, used_usd: 1, limit_usd: 100 }))[2]).toEndWith(`${RED}S: $1.00/$100${R}`);
  });

  test("without both dollar amounts there is no segment, whatever else the limit carries", () => {
    for (const limit of [{ used_percentage: 63, resets_at: 1 }, { used_usd: 3 }, { limit_usd: 10 }, { used_usd: null, limit_usd: 10 }, {}]) {
      expect(rows(spend(limit))).toEqual(base);
    }
    expect(rows({ model, rate_limits: { spend_limit: null } })).toEqual(base);
  });

  test("it ends the usage row, after the usage windows", () => {
    const data: Payload = {
      model,
      cost: { total_lines_added: 4 },
      rate_limits: { five_hour: { used_percentage: 45 }, spend_limit: { used_percentage: 10, used_usd: 1, limit_usd: 10 } },
    };
    expect(rows(data)[2]?.split(S)).toEqual([ZERO, `${filled(G, 4)}${empty(6)} ${G}45%${R} ${D}5h${R}`, `${G}S: $1.00/$10${R}`]);
  });
});

describe("context bar", () => {
  const bar = (context: NonNullable<Payload["context_window"]>, exceeds = false): string =>
    rows({ model: { display_name: "m" }, context_window: context, exceeds_200k_tokens: exceeds, cost: {} })[1] ?? "";
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
    const workspace = (context: NonNullable<Payload["context_window"]>, branch: string, columns: number): string[] =>
      lines({ model: { display_name: "m" }, context_window: { context_window_size: 200000, ...context }, cost: {} }, { ...ON_BRANCH, branch }, {
        ...ASCII,
        COLUMNS: String(columns),
      });
    const blocks = (line: string): number => (visible(line).match(/[▰▱]/g) ?? []).length;

    test("a full line leaves the bar at 8 blocks", () => {
      const line = workspace({ used_percentage: 10 }, "x".repeat(37), Number(usable(60)));
      expect(line).toHaveLength(3);
      expect(blocks(line[1] ?? "")).toBe(8);
      expect(displayWidth(visible(line[1] ?? ""))).toBe(60);
    });

    test("spare cells go to the bar", () => {
      const line = workspace({ used_percentage: 10 }, "x".repeat(27), Number(usable(60)));
      expect(blocks(line[1] ?? "")).toBe(18);
      expect(displayWidth(visible(line[1] ?? ""))).toBe(60);
    });

    test("a roomy line stops at 20 blocks", () => {
      expect(blocks(workspace({ used_percentage: 10 }, "main", 200)[1] ?? "")).toBe(20);
    });

    test("the waiting placeholder follows the same width", () => {
      const line = workspace({}, "x".repeat(28), Number(usable(60)));
      expect(blocks(line[1] ?? "")).toBe(8);
      expect(displayWidth(visible(line[1] ?? ""))).toBe(60);
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

describe("stacked rows", () => {
  const stacked = (rows: readonly (readonly Ranked[])[], columns: number, maxLines: number): string[] =>
    stackRows(rows, columns, maxLines).map((line) => visible(line).replace(/ · /g, "|"));
  const ranked = (text: string, rank: number): Ranked => ({ segment: block(text), rank });
  const [A, B2, C2, D2, E, F] = ["aaaa", "bbbb", "cccc", "dddd", "eeee", "ffff"].map(ranked) as [Ranked, Ranked, Ranked, Ranked, Ranked, Ranked];

  test("each row starts its own line however wide the terminal", () => {
    expect(stacked([[A, B2], [C2, D2], [E, F]], 200, 4)).toEqual(["aaaa|bbbb", "cccc|dddd", "eeee|ffff"]);
  });

  test("an empty row is left out", () => {
    expect(stacked([[A], [], [E]], 200, 4)).toEqual(["aaaa", "eeee"]);
  });

  test("a row too wide for the terminal wraps within itself", () => {
    expect(stacked([[A, B2], [C2, D2, E], [F]], 11, 4)).toEqual(["aaaa|bbbb", "cccc|dddd", "eeee", "ffff"]);
  });

  test("past the line budget the highest rank goes first, and rank 0 always stays", () => {
    const rows = [[A, B2], [C2, D2], [E, F]];
    expect(stacked(rows, 4, 6)).toEqual(["aaaa", "bbbb", "cccc", "dddd", "eeee", "ffff"]);
    expect(stacked(rows, 4, 5)).toEqual(["aaaa", "bbbb", "cccc", "dddd", "eeee"]);
    expect(stacked(rows, 4, 4)).toEqual(["aaaa", "bbbb", "cccc", "dddd"]);
    expect(stacked(rows, 4, 3)).toEqual(["aaaa", "bbbb", "cccc"]);
    expect(stacked(rows, 4, 1)).toEqual(["aaaa"]);
  });

  test("a lower row's head outlasts a higher row's tail", () => {
    const rows = [[ranked("aaaa", 0)], [ranked("cccc", 2), ranked("tail", 13)], [ranked("time", 4)]];
    expect(stacked(rows, 4, 3)).toEqual(["aaaa", "cccc", "time"]);
  });
});

describe("layout", () => {
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
    agent: { name: "oh-my-claudeagent:orchestrator" },
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

  const SESSION_ROW = "> Opus 5.5 · E: high · T: 1/3 -> Wire the order summary panel into the payment step and cover it with a test";
  const USAGE_ROW = "~ 2m05s · ▰▰▰▰▱▱▱▱▱▱ 45% 5h (resets 6pm) · ▰▰▰▰▰▰▰▰▱▱ 80% 7d (resets mon 5pm)";
  const branchOf = (bar: string): string => `${bar} 34%  200k · * v3-typescript-mods ~3  +2  ?1`;
  const BAR_20 = "▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱";

  test("at 120 columns each row starts its own line, and the workspace row wraps within itself", () => {
    expect(at(120).map(visible)).toEqual([
      SESSION_ROW,
      `${branchOf("▰▰▰▰▱▱▱▱▱▱▱▱")} · > ${basename(dir)} · W: wt <- main · #42 +`,
      "+42/-7 · +2 dirs",
      USAGE_ROW,
    ]);
  });

  test.each([200, 300])("at %p columns each row is one line of its own", (columns) => {
    expect(at(columns).map(visible)).toEqual([SESSION_ROW, `${branchOf(BAR_20)} · > ${basename(dir)} · W: wt <- main · #42 + · +42/-7 · +2 dirs`, USAGE_ROW]);
  });

  test("at 80 columns the rows wrap, and the lowest-ranked segments drop so the time and 5 hour limit stay", () => {
    expect(at(80).map(visible)).toEqual([
      "> Opus 5.5 · E: high · T: 1/3 -> Wire the order summary panel into the pa…",
      branchOf(BAR_20),
      `> ${basename(dir)} · W: wt <- main · #42 +`,
      "~ 2m05s · ▰▰▰▰▱▱▱▱▱▱ 45% 5h (resets 6pm)",
    ]);
  });

  test("a short terminal keeps only the highest-ranked segments: model, plan, context and branch", () => {
    expect(at(80, 19).map(visible)).toEqual([
      "> Opus 5.5 · E: high · T: 1/3 -> Wire the order summary panel into the pa…",
      branchOf(BAR_20),
    ]);
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
    expect(at(200).map(visible)[0]).toBe("> Opus 5.5 · E: high · T: 1/3 -> Wire the order summary panel into the payment step and cover it with a test");
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
});
