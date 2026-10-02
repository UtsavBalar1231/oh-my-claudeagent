import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { displayWidth } from "../src/core/ui-kit.ts";
import { NO_REPO } from "./git.ts";
import type { GitInfo } from "./git.ts";
import {
  AGENT_GLYPHS,
  composeRepoPr,
  detectNerdFont,
  fixed,
  formatResetTime,
  type Payload,
  projectDirOf,
  render,
  renderBar,
  terminalColumns,
  todoCounter,
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
const ON_BRANCH: GitInfo = { ...NO_REPO, repo: true, branch: "main" };

function lines(data: Payload, git: GitInfo = ON_BRANCH, env: Record<string, string> = ASCII): string[] {
  return render(data, git, env, NOW)
    .split("\n")
    .map((line) => {
      expect(line.endsWith(R)).toBe(true);
      return line.slice(0, -R.length);
    });
}

const BAR_10 = `${filled(G, 2)}${empty(18)} ${G}10%${R}  ${D}200k${R}`;
const withCost = (cost: NonNullable<Payload["cost"]>, context: NonNullable<Payload["context_window"]> = {}): Payload => ({
  model: { display_name: "m" },
  context_window: { context_window_size: 200000, used_percentage: 10, ...context },
  cost,
});
const metrics = (data: Payload): string => lines(data)[1] ?? "";
const clock = (duration: string): string => `${B}~ ${duration}${R}`;

describe("environment", () => {
  test.each([
    [{ CLAUDE_STATUSLINE_NERD_FONT: "1" }, true],
    [{ CLAUDE_STATUSLINE_NERD_FONT: "0" }, false],
    [{ CLAUDE_STATUSLINE_NERD_FONT: " 1 " }, true],
    [{ NERD_FONT: "1" }, true],
    [{ NERD_FONT: "0" }, false],
    [{ CLAUDE_STATUSLINE_NERD_FONT: "0", NERD_FONT: "1" }, false],
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

  test("no rendered line is wider than the terminal", () => {
    const data: Payload = {
      model: { display_name: "Claude Opus With A Very Long Display Name" },
      workspace: { project_dir: `/tmp/${"deeply".repeat(10)}`, repo: { owner: "a".repeat(40), name: "b".repeat(40) } },
      pr: { number: 1234, kind: "mr", review_state: "approved" },
      session_name: "s".repeat(60),
      context_window: { context_window_size: 200000, used_percentage: 50 },
      cost: { total_cost_usd: 1.23, total_duration_ms: 90000 },
      rate_limits: { five_hour: { used_percentage: 10 } },
      output_style: { name: "some-other-style" },
      version: "2.1.245",
    };
    const rendered = lines(data, NO_REPO, { ...ASCII, COLUMNS: "60" });
    expect(rendered).toHaveLength(4);
    for (const line of rendered) expect([...visible(line)].length).toBeLessThanOrEqual(60);
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

describe("repository and pull request segment", () => {
  const withRepo = (repo: object, pr?: object): Payload => ({ workspace: { repo }, ...(pr ? { pr } : {}) });

  test.each([
    [{}],
    [{ workspace: {} }],
    [{ workspace: { repo: { name: "" } } }],
    [{ workspace: { repo: { owner: "acme" } } }],
  ] as [Payload][])("%o has no segment", (data) => {
    expect(composeRepoPr(data, false)).toBe("");
  });

  test("a bare repository name is dim text", () => {
    expect(composeRepoPr(withRepo({ name: "myrepo" }), false)).toBe(`${D}myrepo${R}`);
  });

  test("an owner prefixes the name", () => {
    expect(composeRepoPr(withRepo({ owner: "myorg", name: "myrepo" }), false)).toBe(`${D}myorg/myrepo${R}`);
  });

  test("a host and owner link the label to the repository", () => {
    const repo = { host: "github.com", owner: "myorg", name: "myrepo" };
    expect(composeRepoPr(withRepo(repo), false)).toBe(`${D}${link("https://github.com/myorg/myrepo", "myorg/myrepo")}${R}`);
  });

  test("a host without an owner does not link", () => {
    expect(composeRepoPr(withRepo({ host: "github.com", name: "myrepo" }), false)).toBe(`${D}myrepo${R}`);
  });

  test("a pull request number follows the repository", () => {
    expect(composeRepoPr(withRepo({ name: "r" }, { number: 42 }), false)).toBe(`${D}r${R} ${C}#42${R}`);
  });

  test("a pull request without a number is left out", () => {
    expect(composeRepoPr(withRepo({ name: "r" }, { url: "https://x/1", review_state: "approved" }), false)).toBe(`${D}r${R}`);
  });

  test("a pull request url links the number", () => {
    expect(composeRepoPr(withRepo({ name: "r" }, { number: 7, url: "https://github.com/o/r/pull/7" }), false)).toBe(
      `${D}r${R} ${C}${link("https://github.com/o/r/pull/7", "#7")}${R}`,
    );
  });

  test.each([
    ["mr", "!"],
    ["pr", "#"],
    [undefined, "#"],
  ])("a pull request of kind %p uses the %p sigil", (kind, sigil) => {
    expect(composeRepoPr(withRepo({ name: "r" }, { number: 9, kind }), false)).toBe(`${D}r${R} ${C}${sigil}9${R}`);
  });

  test.each([
    ["approved", G, "\uf00c", "+"],
    ["changes_requested", RED, "\uf00d", "!"],
    ["pending", Y, "\uf017", "?"],
    ["draft", D, "\uf040", "d"],
  ])("review state %s is %s with a Nerd Font glyph and an ASCII fallback", (state, color, nerd, ascii) => {
    const data = withRepo({ name: "r" }, { number: 5, review_state: state });
    expect(composeRepoPr(data, true)).toBe(`${D}r${R} ${C}#5${R} ${color}${nerd}${R}`);
    expect(composeRepoPr(data, false)).toBe(`${D}r${R} ${C}#5${R} ${color}${ascii}${R}`);
  });

  test.each([["unknown_future_state"], ["constructor"]])("review state %s adds no glyph", (state) => {
    expect(composeRepoPr(withRepo({ name: "r" }, { number: 5, review_state: state }), true)).toBe(`${D}r${R} ${C}#5${R}`);
  });
});

describe("plan token", () => {
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

  const token = (sessionId = SESSION, nerdFont = false): string => todoCounter(dir, sessionId, nerdFont);

  test("an open task shows progress and its label", () => {
    bind(THREE_OF_TEN);
    expect(token()).toBe(`${G}T: 3/10${R} ${D}-> Pending 4${R}`);
  });

  test("the Nerd Font token uses the task glyph and a unicode arrow", () => {
    bind(THREE_OF_TEN);
    expect(token(SESSION, true)).toBe(`${G}\uf0ae 3/10${R} ${D}→ Pending 4${R}`);
  });

  test("a plan with nothing done counts zero", () => {
    bind("- [ ] 1. First\n- [ ] 2. Second\n");
    expect(token()).toBe(`${G}T: 0/2${R} ${D}-> First${R}`);
  });

  test("a task without a label shows only the count", () => {
    bind("- [x] 1. Done\n- [ ] 2.\n");
    expect(token()).toBe(`${G}T: 1/2${R}`);
  });

  test("a label is cut to 80 characters with an ellipsis", () => {
    bind(`- [ ] 1. ${"a".repeat(100)}\n`);
    expect(token()).toBe(`${G}T: 0/1${R} ${D}-> ${"a".repeat(79)}…${R}`);
  });

  test.each([
    ["every task checked", "- [x] 1. First\n- [x] 2. Second\n"],
    ["only unnumbered checkboxes", "# Plan\n\n- [ ] just a note\n- [x] another note\n"],
    ["an empty plan", ""],
  ])("a bound plan with %s shows no token", (_, plan) => {
    bind(plan);
    expect(token()).toBe("");
  });

  test("a bound plan whose file is gone shows no token", () => {
    bind(null);
    expect(token()).toBe("");
  });

  test("no registry shows no token", () => {
    expect(token()).toBe("");
  });

  test("an empty project directory shows no token", () => {
    expect(todoCounter("", SESSION, false)).toBe("");
  });

  test("a binding for another session shows no token even when it is the only plan", () => {
    bind(THREE_OF_TEN, "some-other-session");
    expect(token("sess-new")).toBe("");
  });

  test("an empty session id shows no token", () => {
    bind(THREE_OF_TEN);
    expect(token("")).toBe("");
  });

  test("a plan entry with a null path shows no token", () => {
    writeBoulder({ plans: { p: { active_plan: null } }, bindings: { [SESSION]: { plan_name: "p" } } });
    expect(token()).toBe("");
  });

  test("a binding to a plan missing from the registry shows no token", () => {
    writeBoulder({ plans: {}, bindings: { [SESSION]: { plan_name: "ghost" } } });
    expect(token()).toBe("");
  });

  test("an empty registry shows no token", () => {
    writeBoulder({ plans: {}, bindings: {} });
    expect(token()).toBe("");
  });

  describe("shared registry schemas", () => {
    const schema = (name: string): Record<string, unknown> =>
      JSON.parse(readFileSync(join(import.meta.dir, "..", "tests", "fixtures", "boulder-schemas", `${name}.json`), "utf8"));
    const rawSchema = (name: string): string => readFileSync(join(import.meta.dir, "..", "tests", "fixtures", "boulder-schemas", `${name}.json`), "utf8");

    test("a flat registry resolves no plan", () => {
      writeFileSync(join(dir, "plan.md"), THREE_OF_TEN);
      writeBoulder({ ...schema("old-flat"), active_plan: join(dir, "plan.md") });
      expect(token("sess-flat")).toBe("");
    });

    test("an explicit binding picks its own plan among several", () => {
      writeFileSync(join(dir, "plan-a.md"), "- [ ] 1. First\n- [ ] 2. Second\n");
      writeFileSync(join(dir, "plan-b.md"), THREE_OF_TEN);
      const registry = schema("two-plan") as { plans: Record<string, { active_plan: string }>; bindings: Record<string, unknown> };
      registry.plans["plan-a"] = { active_plan: join(dir, "plan-a.md") };
      registry.plans["plan-b"] = { active_plan: join(dir, "plan-b.md") };
      registry.bindings["sess-bound"] = { plan_name: "plan-b", bound_at: "2026-03-01T00:00:00Z" };
      writeBoulder(registry);
      expect(token("sess-bound")).toBe(`${G}T: 3/10${R} ${D}-> Pending 4${R}`);
    });

    test("an unbound session among several plans shows no token", () => {
      writeFileSync(join(dir, "plan-b.md"), THREE_OF_TEN);
      const registry = schema("two-plan") as { plans: Record<string, { active_plan: string }> };
      registry.plans["plan-b"] = { active_plan: join(dir, "plan-b.md") };
      writeBoulder(registry);
      expect(token("sess-unbound")).toBe("");
    });

    test.each([["corrupt"], ["half-written"]])("a %s registry shows no token", (name) => {
      writeBoulder(rawSchema(name));
      expect(token("sess")).toBe("");
    });
  });
});

describe("info line", () => {
  const line1 = (data: Payload, git: GitInfo = ON_BRANCH, env: Record<string, string> = ASCII): string => lines(data, git, env)[0] ?? "";
  const model = { display_name: "claude" };

  test("a model without a name reads Claude", () => {
    expect(line1({ model: {}, cost: {} }, NO_REPO)).toStartWith(`${C}> Claude${R}`);
  });

  test.each(["low", "medium", "high", "xhigh", "max"])("effort level %s renders as given", (level) => {
    expect(line1({ model, effort: { level } })).toBe(`${C}> claude${R}${S}${Y}E: ${level}${R}${S}${W}* main${R}`);
  });

  test("effort and thinking use Nerd Font glyphs when enabled", () => {
    expect(line1({ model, effort: { level: "high" }, thinking: { enabled: true } }, NO_REPO, NERD)).toBe(
      `${C}\uf135 claude${R}${S}${Y}\uf0e7 high${R}${S}${C}\uf0eb${R}`,
    );
  });

  test("thinking falls back to a bracketed marker", () => {
    expect(line1({ model, thinking: { enabled: true } }, NO_REPO)).toBe(`${C}> claude${R}${S}${C}[T]${R}`);
  });

  test("thinking disabled adds nothing", () => {
    expect(lines({ model, thinking: { enabled: false } }, NO_REPO)).toHaveLength(1);
  });

  test("a session id shows its first eight characters", () => {
    expect(line1({ model, session_id: "abcdef1234567890" })).toBe(`${C}> claude${R}${S}${D}abcdef12${R}${S}${W}* main${R}`);
  });

  test("a transcript path links the session label", () => {
    expect(line1({ model, session_name: "my-sess", transcript_path: "/tmp/s.jsonl" })).toBe(
      `${C}> claude${R}${S}${D}${link("file:///tmp/s.jsonl", "my-sess")}${R}${S}${W}* main${R}`,
    );
  });

  test.each([
    ["/tmp/my dir/s#1.jsonl", "file:///tmp/my%20dir/s%231.jsonl"],
    ["/Users/Me/.claude/projects/p/s.jsonl", "file:///Users/Me/.claude/projects/p/s.jsonl"],
    ["C:\\Users\\x y\\.claude\\projects\\p\\s.jsonl", "file:///C:/Users/x%20y/.claude/projects/p/s.jsonl"],
    ["C:/Users/x/s.jsonl", "file:///C:/Users/x/s.jsonl"],
    ["\\\\srv\\share\\p\\s.jsonl", "file://srv/share/p/s.jsonl"],
  ])("the transcript path %p links as %p", (transcript_path, url) => {
    expect(line1({ model, session_name: "my-sess", transcript_path })).toBe(
      `${C}> claude${R}${S}${D}${link(url, "my-sess")}${R}${S}${W}* main${R}`,
    );
  });

  test.each([
    ["/home/user/projects/myrepo", "myrepo"],
    ["/Users/Me/My Repo", "My Repo"],
    ["C:\\Users\\x\\proj", "proj"],
    ["C:/Users/x/proj/", "proj"],
    ["\\\\srv\\share\\proj", "proj"],
  ])("the folder segment of project %p is %p", (project_dir, name) => {
    expect(line1({ model, workspace: { project_dir } })).toBe(`${C}> claude${R}${S}${W}* main${R}${S}${D}> ${name}${R}`);
  });

  test.each(["/", "C:\\", "\\\\srv\\share"])("the project root %p shows no folder segment", (project_dir) => {
    expect(line1({ model, workspace: { project_dir } })).toBe(`${C}> claude${R}${S}${W}* main${R}`);
  });

  test("a worktree branch replaces the repository branch", () => {
    expect(line1({ model, worktree: { name: "wt", branch: "feature/x", original_branch: "main" } })).toBe(
      `${C}> claude${R}${S}${W}* feature/x${R}${S}${B}W: wt${R} ${D}<- main${R}`,
    );
  });

  test("branch counts show modified, staged and untracked in that order", () => {
    expect(line1({ model }, { ...ON_BRANCH, modified: 3, staged: 2, untracked: 1 })).toBe(
      `${C}> claude${R}${S}${W}* main${R}${S}${Y}~3${R}  ${G}+2${R}  ${D}?1${R}`,
    );
  });

  test("a repository without a branch shows none", () => {
    expect(lines({ model }, { ...ON_BRANCH, branch: "" })[0]).toBe(`${C}> claude${R}`);
  });

  test("an SSH remote links the directory to its web address", () => {
    const git = { ...ON_BRANCH, remote: "git@github.com:user/repo.git" };
    expect(line1({ model, cwd: "/work/repo" }, git)).toBe(
      `${C}> claude${R}${S}${W}* main${R}${S}${D}> ${link("https://github.com/user/repo", "repo")}${R}`,
    );
  });

  test.each([
    [1, "+1 dir"],
    [2, "+2 dirs"],
  ])("%p added directories read %p", (count, text) => {
    const added = Array.from({ length: count }, (_, i) => `/x${i}`);
    expect(line1({ model, workspace: { added_dirs: added } }, NO_REPO)).toBe(`${C}> claude${R}${S}${D}${text}${R}`);
  });

  test.each([
    ["sisyphus", "A:"],
    ["oh-my-claudeagent:sisyphus", "A:"],
  ])("agent %s is marked %s without Nerd Font", (name, glyph) => {
    expect(line1({ model, agent: { name } }, NO_REPO)).toBe(`${C}> claude${R}${S}${M}${glyph} ${name}${R}`);
  });

  test.each([
    ["sisyphus", "\uef08"],
    ["oh-my-claudeagent:executor", "\uf085"],
    ["someone-else", "\uf007"],
    ["constructor", "\uf007"],
  ])("agent %s gets glyph %p with Nerd Font", (name, glyph) => {
    expect(line1({ model, agent: { name } }, NO_REPO, NERD)).toBe(`${C}\uf135 claude${R}${S}${M}${glyph} ${name}${R}`);
  });

  test("every shipped agent has its own glyph", () => {
    const shipped = readdirSync(join(import.meta.dir, "..", "agents")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -".md".length));
    expect(shipped.filter((name) => !AGENT_GLYPHS.has(name))).toEqual([]);
  });

  test("an agent without a name still forces the full layout", () => {
    expect(lines({ model, agent: {} }, NO_REPO)).toHaveLength(2);
  });

  test("vim mode shows its first letter", () => {
    expect(line1({ model, vim: { mode: "normal" } }, NO_REPO)).toBe(`${C}> claude${R}${S}${Y}V: n${R}`);
  });

  const BRANCH = `${C}> claude${R}${S}${W}* main${R}`;
  test.each([
    ["default", BRANCH],
    ["OMCA Default", `${BRANCH}${S}${D}S: OMCA Default${R}`],
    ["oh-my-claudeagent:OMCA Default", `${BRANCH}${S}${D}S: OMCA Default${R}`],
    ["compact", `${BRANCH}${S}${RED}! DEGRADED: compact${R}`],
    ["some-plugin:Compact", `${BRANCH}${S}${RED}! DEGRADED: some-plugin:Compact${R}`],
  ])("output style %s", (name, expected) => {
    expect(line1({ model, output_style: { name } })).toBe(expected);
  });

  test("a degraded style adds a tip line, and OMCA Default does not", () => {
    expect(lines({ model, output_style: { name: "compact" } }, NO_REPO)[2]).toBe(
      `${D}-> run ${R}${Y}/oh-my-claudeagent:omca-setup${R}${D} to diagnose / clear pin -> restart Claude Code to load OMCA Default${R}`,
    );
    expect(lines({ model, output_style: { name: "OMCA Default" } }, NO_REPO)).toHaveLength(2);
  });

  test("the version closes the line", () => {
    expect(line1({ model, version: "2.1.287" })).toBe(`${C}> claude${R}${S}${W}* main${R}${S}${D}v2.1.287${R}`);
  });
});

describe("metrics line", () => {
  test.each([
    [{ total_cost_usd: 1.23 }, "$1.23"],
    [{}, "$0.00"],
    [{ total_cost_usd: 0.125 }, "$0.12"],
  ])("cost %o reads %s", (cost, text) => {
    expect(metrics(withCost(cost))).toBe([BAR_10, `${M}${text}${R}`, clock("0m 0s")].join(S));
  });

  test.each([
    [0, "0m 0s"],
    [999, "0m 0s"],
    [61000, "1m 1s"],
    [90000, "1m 30s"],
    [3600000, "60m 0s"],
  ])("a duration of %p ms reads %s", (ms, text) => {
    expect(metrics(withCost({ total_duration_ms: ms }))).toBe([BAR_10, `${M}$0.00${R}`, clock(text)].join(S));
  });

  test.each([
    [{ total_lines_added: 42, total_lines_removed: 17 }, `${G}+42${R}/${RED}-17${R}`],
    [{ total_lines_added: 42 }, `${G}+42${R}`],
    [{ total_lines_removed: 17 }, `${RED}-17${R}`],
  ])("changed lines %o read %s", (cost, text) => {
    expect(metrics(withCost(cost))).toBe([BAR_10, `${M}$0.00${R}`, clock("0m 0s"), text].join(S));
  });

  test("zero changed lines are left out", () => {
    expect(metrics(withCost({ total_lines_added: 0, total_lines_removed: 0 }))).toBe([BAR_10, `${M}$0.00${R}`, clock("0m 0s")].join(S));
  });

  test.each([
    [{ total_input_tokens: 15000, total_output_tokens: 1200 }, "16.2k"],
    [{ total_input_tokens: 5000 }, "5.0k"],
    [{ total_input_tokens: 999 }, "999"],
    [{ total_input_tokens: 12345 }, "12.3k"],
    [{ total_input_tokens: 2_500_000 }, "2.5M"],
    [{ total_input_tokens: 1_250_000 }, "1.2M"],
  ])("tokens %o read %s", (context, text) => {
    expect(metrics(withCost({}, context))).toBe([BAR_10, `${M}$0.00${R}`, clock("0m 0s"), `${D}${text} tok${R}`].join(S));
  });

  test("zero tokens are left out", () => {
    expect(metrics(withCost({}, { total_input_tokens: 0, total_output_tokens: 0 }))).toBe([BAR_10, `${M}$0.00${R}`, clock("0m 0s")].join(S));
  });

  test.each([
    [23456, "api 23s"],
    [500, "api 0s"],
  ])("api time %p ms reads %s", (ms, text) => {
    expect(metrics(withCost({ total_api_duration_ms: ms }))).toBe([BAR_10, `${M}$0.00${R}`, clock("0m 0s"), `${D}${text}${R}`].join(S));
  });
});

describe("context bar", () => {
  const bar = (context: NonNullable<Payload["context_window"]>, exceeds = false): string =>
    (lines({ model: { display_name: "m" }, context_window: context, exceeds_200k_tokens: exceeds, cost: {} })[1] ?? "").split(S)[0] ?? "";
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
});

describe("layout", () => {
  const model = { display_name: "claude" };

  test("without a repository or any extra segment the model, bar, cost and clock share one line", () => {
    expect(lines({ model, context_window: { used_percentage: 10 }, cost: {} }, NO_REPO)).toEqual([[`${C}> claude${R}`, BAR_10, `${M}$0.00${R}`, clock("0m 0s")].join(S)]);
  });

  test("a repository forces two lines", () => {
    expect(lines({ model, context_window: { used_percentage: 10 }, cost: {} })).toHaveLength(2);
  });

  test("a rate limit adds a third line", () => {
    expect(lines({ model, rate_limits: { five_hour: { used_percentage: 45 } } })).toHaveLength(3);
  });

  test("resets times that cannot be read leave the bar bare", () => {
    expect(lines({ model, rate_limits: { five_hour: { used_percentage: 45, resets_at: null } } })[2]).toBe(
      `${filled(G, 4)}${empty(6)} ${G}45%${R} ${D}5h ${R}`,
    );
  });

  test("resets without any percentage add no line", () => {
    expect(lines({ model, rate_limits: { five_hour: { resets_at: 1 } } })).toHaveLength(2);
  });

  test("the subagent count file is not read", () => {
    const dir = mkdtempSync(join(tmpdir(), "omca-statusline-agents-"));
    try {
      const data: Payload = { model, workspace: { project_dir: dir } };
      const before = lines(data);
      mkdirSync(join(dir, ".omca", "state"), { recursive: true });
      writeFileSync(join(dir, ".omca", "state", "subagent-models.json"), JSON.stringify({ a1: { model: "Sonnet" }, a2: { model: "Opus" } }));
      expect(lines(data)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
