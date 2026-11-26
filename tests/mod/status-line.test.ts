import type { On, ProcessRunResult, SessionRateLimit } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { modelName } from "../../hooks/status-line.ts";
import { PLUGIN, ROOT, textOf, world } from "./world.ts";

const ENGINE_LINE = "engine line";
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const SGR_AND_LINKS = new RegExp(`${ESC}\\[[0-9;]*m|${ESC}\\]8;;[^${BEL}]*${BEL}`, "g");
const plain = (text: string): string => text.replace(SGR_AND_LINKS, "");
const STARTED_MS = Date.UTC(2026, 9, 2, 12, 0, 0);
const STATUS = `git -C ${ROOT} status --porcelain=v2 --branch -u`;
const REMOTE = `git -C ${ROOT} remote get-url origin`;
const DIRTY = ["# branch.oid 0123456789abcdef", "# branch.head feature/line", "1 .M N... 100644 100644 100644 a b src/a.ts", "1 M. N... 100644 100644 100644 a b src/b.ts", "? new.ts", "? other.ts"].join("\n");

type Git = Partial<Record<string, Partial<ProcessRunResult> | "reject">>;
type Setup = { env?: Record<string, string>; settings?: Record<string, unknown>; git?: Git; rateLimits?: SessionRateLimit[]; agentType?: string; model?: string };

function engine(on: On, { env = {}, settings = {}, git = { [STATUS]: { stdout: DIRTY }, [REMOTE]: { stdout: "git@github.com:acme/app.git\n" } }, rateLimits = [], agentType, model = "Opus 5.5" }: Setup = {}) {
  const ran: { argv: string; env: Record<string, string> | undefined }[] = [];
  on("process.run", (_$, e, next) => {
    const argv = e.argv.join(" ");
    if (!argv.startsWith(`git -C ${ROOT} `)) return next(e);
    ran.push({ argv, env: e.init?.env });
    const result = git[argv];
    if (result === undefined || result === "reject") return { deny: "git failed" };
    return { value: { exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false, ...result } };
  });
  const w = world(on, {}, settings, env);
  on("session.cwd", () => ({ value: ROOT }));
  on("session.model", () => (fresh.calls++, { value: model }));
  on("session.info", () => ({ value: { transcriptPath: "", ...(agentType === undefined ? {} : { agentType }) } as never }));
  const fresh = { calls: 0 };
  on("session.usage", () => ({
    value: { startedAt: STARTED_MS - 125_000, context: { window: 200_000, percent: 34 }, rateLimits, cost: { usd: 1.5 } },
  }));
  on("ui.render", ($, e) => $.ui.resolve(e).Text({ children: [e.component === "StatusLine" ? plain(e.props.text ?? ENGINE_LINE) : ""] }));
  return { w, ran, fresh };
}

async function draw($: Engine, props: { text?: string | null; isManaged?: boolean; maxRows?: number; columns?: number } = {}): Promise<string> {
  const mounted = await $.ui.mount({
    plugin: PLUGIN,
    surface: "terminal",
    component: "StatusLine",
    requestId: "status",
    props: { text: null, isManaged: false, isWorking: false, maxRows: 4, columns: 200, ...props },
  });
  const text = textOf(await mounted.drawn());
  await mounted.unmount();
  return text;
}

test("with no command set it draws OMCA's line from the engine's figures", async ($, on) => {
  const { ran } = engine(on);
  const text = await draw($);

  expect(text).toContain("> Opus 5.5");
  expect(text).toContain("34%");
  expect(text).toContain("$1.50");
  expect(text).toContain("2m05s");
  expect(text).toContain("* feature/line ~1  +1  ?2");
  expect(text).toContain("> work");
  expect(ran.map(({ argv }) => argv).sort()).toEqual([REMOTE, STATUS].sort());
  expect(ran[0]?.env).toEqual({ LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" });
});

test("the session's subscription windows draw their limits and take the cost's place", async ($, on) => {
  engine(on, { rateLimits: [{ kind: "five_hour", percentUsed: 45, resetsAt: "2099-01-01T18:00:00Z" }, { kind: "other", percentUsed: 9 }] });
  const text = await draw($);

  expect(text).toContain("45% 5h");
  expect(text).not.toContain("$1.50");
});

test("a named main agent other than the default shows beside the model", async ($, on) => {
  engine(on, { agentType: "oh-my-claudeagent:executor" });
  expect(await draw($)).toContain("A: oh-my-claudeagent:executor");
});

test("a model id reads as its name, and the session's main agent shows when no agent type is set", async ($, on) => {
  engine(on, { settings: { agent: "oh-my-claudeagent:planner" }, model: "claude-opus-5-5" });
  const line = await draw($);
  expect(line).toContain("Opus 5.5");
  expect(line).not.toContain("claude-opus-5-5");
  expect(line).toContain("A: oh-my-claudeagent:planner");
});

test("a turn step's effort shows on the next drawing", async ($, on) => {
  const { w } = engine(on);
  on("turn.step", async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: "", toolUses: [], stopReason: "end_turn", usage: null };
  });
  const stream = $.turn.step({ turnId: "t-1", index: 0, model: "claude-opus-5-5", effort: "high", messageCount: 1 });
  while ((await stream.next()).done !== true);

  expect(w.invalidations).toBe(1);
  expect(await draw($)).toContain("E: high");
});

test("steps of a long turn redraw the line at most once in five seconds", async ($, on) => {
  const { w } = engine(on);
  on("turn.step", async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: "", toolUses: [], stopReason: "tool_use", usage: null };
  });
  const step = async (index: number) => {
    const stream = $.turn.step({ turnId: "t-2", index, model: "claude-opus-5-5", effort: "high", messageCount: index + 1 });
    while ((await stream.next()).done !== true);
  };
  await w.clock.advance(60_000);
  await step(0);
  const first = w.invalidations;
  await w.clock.advance(1_000);
  await step(1);
  expect(w.invalidations).toBe(first);
  await w.clock.advance(5_000);
  await step(2);
  expect(w.invalidations).toBe(first + 1);
});

test("a main turn's end redraws the line, and a subagent's does not", async ($, on) => {
  const { w } = engine(on);
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  const done = (agentId?: string) =>
    $.turn.complete({ answer: "ok", durationMs: 1, isAborted: false, turnId: "t-1", reason: "answer", ...(agentId === undefined ? {} : { agentId }) });
  await done("a1");
  expect(w.invalidations).toBe(0);
  await done();
  expect(w.invalidations).toBe(1);
});

test("git is read once for the draws inside five seconds, and again after", async ($, on) => {
  const { w, ran } = engine(on);
  await draw($);
  await draw($);
  expect(ran).toHaveLength(2);

  await w.clock.advance(5_000);
  await draw($);
  expect(ran).toHaveLength(4);
});

test("a git failure draws the line without its branch and counts", async ($, on) => {
  engine(on, { git: { [STATUS]: "reject", [REMOTE]: "reject" } });
  const text = await draw($);

  expect(text).toContain("> Opus 5.5");
  expect(text).toContain("34%");
  expect(text).not.toContain("feature/line");
  expect(text).not.toContain("~1");
});

test("a status that exits non-zero, as outside a repository, draws no branch", async ($, on) => {
  engine(on, { git: { [STATUS]: { exitCode: 128, stderr: "fatal: not a git repository" }, [REMOTE]: { exitCode: 128 } } });
  expect(await draw($)).not.toContain("*");
});

test("a command the settings name leaves the engine's line", async ($, on) => {
  engine(on, { settings: { statusLine: { type: "command", command: "my-line" } } });
  expect(await draw($)).toBe(ENGINE_LINE);
});

test("a managed command leaves the engine's line", async ($, on) => {
  engine(on);
  expect(await draw($, { isManaged: true })).toBe(ENGINE_LINE);
});

test("a command's own output is left as it is", async ($, on) => {
  engine(on);
  expect(await draw($, { text: "from the command" })).toBe("from the command");
});

test("statuslineMode off leaves the engine's line", { options: { statuslineMode: "off" } }, async ($, on) => {
  engine(on);
  expect(await draw($)).toBe(ENGINE_LINE);
});

test("status-line in OMCA_DISABLED_HOOKS leaves the engine's line", async ($, on) => {
  engine(on, { env: { OMCA_DISABLED_HOOKS: "status-line" } });
  expect(await draw($)).toBe(ENGINE_LINE);
});

test("a site with no row to spare leaves the engine's line", async ($, on) => {
  engine(on);
  expect(await draw($, { maxRows: 0 })).toBe(ENGINE_LINE);
});

test("maxRows caps the lines drawn", async ($, on) => {
  engine(on);
  const lineCount = async (maxRows: number) => (await draw($, { maxRows })).split("\n").length;

  expect(await lineCount(4)).toBeGreaterThan(2);
  expect(await lineCount(2)).toBe(2);
  expect(await lineCount(1)).toBe(1);
});

test("a model id maps to the name the settings payload uses, and anything else passes through", () => {
  expect(["claude-opus-5-5", "claude-fable-5", "claude-sonnet-5-5-20261001", "claude-opus-5-5[1m]", "Opus 5.5", "gpt-x"].map(modelName)).toEqual([
    "Opus 5.5", "Fable 5", "Sonnet 5.5", "Opus 5.5", "Opus 5.5", "gpt-x",
  ]);
});

test("a line drawn under a second ago is reused at the same size, and a turn's end draws it afresh", async ($, on) => {
  const { w, fresh } = engine(on);
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  await draw($);
  await draw($);
  expect(fresh.calls).toBe(1);
  await draw($, { columns: 90 });
  expect(fresh.calls).toBe(2);

  await $.turn.complete({ answer: "Done.", durationMs: 10, isAborted: false, reason: "answer", turnId: "t-9" });
  await draw($, { columns: 90 });
  expect(fresh.calls).toBe(3);

  await w.clock.advance(1_000);
  await draw($, { columns: 90 });
  expect(fresh.calls).toBe(4);
});
