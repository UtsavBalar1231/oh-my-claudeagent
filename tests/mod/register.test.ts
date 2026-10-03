import type { SessionMessage } from "claude-code";
import { expect, test } from "claude-code/testing";
import { split, USAGE } from "../../hooks/omca-router.ts";
import { readOptions } from "../../hooks/register.ts";

const PLUGIN = "oh-my-claudeagent";
const RUN = { origin: { kind: "composer" }, presentation: { isFullscreen: true, columns: 120 } } as const;
const ATOMS = [
  "agents",
  "band",
  "costSample",
  "dialogs",
  "doctor",
  "nextActions",
  "pane",
  "plan",
  "routes",
  "stats",
  "status",
].map((key) => ({ plugin: PLUGIN, key }));

test("the module registers exactly the dispatchers, env reads and atoms of the contract", async ($, on) => {
  const uses: unknown[] = [];
  on("plugin.register", (_$, e) => {
    if (e.name === PLUGIN) uses.push(e.uses);
    return { allow: true };
  });
  on("session.start", () => ({ cwd: "/engine" }));

  await $.session.start({ cwd: "/work", surface: "terminal", isInteractive: true });

  expect(uses).toEqual([
    {
      events: [
        "tool.check",
        "session.start",
        "turn.start",
        "turn.step",
        "turn.complete",
        "agent.spawn",
        "prompt.edit",
        "ui.close",
        "ui.focus",
        "ui.scroll",
        "command.run",
        "ui.render",
        "session.compact",
      ],
      calls: [
        "agent.list",
        "clock.after",
        "clock.every",
        "clock.now",
        "command.register",
        "env.get",
        "fs.exists",
        "fs.list",
        "fs.read",
        "fs.stat",
        "fs.write",
        "process.run",
        "prompt.fill",
        "session.cwd",
        "session.id",
        "session.root",
        "session.surfaces",
        "session.usage",
        "session.version",
        "settings.read",
        "state.get",
        "state.set",
        "ui.ask",
        "ui.focus",
        "ui.invalidate",
        "ui.log",
        "ui.open",
        "ui.panes",
        "ui.resolve",
        "ui.selection",
      ],
      env: {
        reads: [
          "CLAUDE_CODE_DISABLE_ADVISOR_TOOL",
          "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
          "CLAUDE_CODE_SUBAGENT_MODEL_FORCE",
          "CLAUDE_CONFIG_DIR",
          "DISABLE_GROWTHBOOK",
          "DISABLE_TELEMETRY",
          "DO_NOT_TRACK",
          "HOME",
          "HOMEDRIVE",
          "HOMEPATH",
          "OMCA_ASCII",
          "OMCA_DISABLED_HOOKS",
          "USERPROFILE",
        ],
        writes: [],
      },
      state: { reads: ATOMS, writes: ATOMS },
    },
  ]);
});

test("the Bash check passes the engine's verdict through once, unchanged", async ($, on) => {
  const seen: unknown[] = [];
  on("tool.check", (_$, e) => (seen.push(e), { decision: "ask", reason: "Bash(ls:*) asks" }));

  const verdict = await $.tool.check({ tool: "Bash", input: { command: "ls build" } });

  expect(verdict).toEqual({ decision: "ask", reason: "Bash(ls:*) asks" });
  expect(seen).toEqual([{ tool: "Bash", input: { command: "ls build" } }]);
});

test("a Bash check whose dispatcher fails is denied by the registration's catch", async ($) => {
  const verdict = await $.tool.check({ tool: "Bash", input: { command: "ls" } });

  expect(verdict).toEqual({
    decision: "deny",
    reason: "OMCA's Bash guard failed, so the command was refused: no implementation for tool.check",
  });
});

test("the PowerShell check passes the engine's verdict through once, unchanged", async ($, on) => {
  const seen: unknown[] = [];
  on("tool.check", (_$, e) => (seen.push(e), { decision: "ask", reason: "PowerShell(Get-ChildItem) asks" }));

  const verdict = await $.tool.check({ tool: "PowerShell", input: { command: "Get-ChildItem build" } });

  expect(verdict).toEqual({ decision: "ask", reason: "PowerShell(Get-ChildItem) asks" });
  expect(seen).toEqual([{ tool: "PowerShell", input: { command: "Get-ChildItem build" } }]);
});

test("a PowerShell check whose dispatcher fails is denied by the registration's catch", async ($) => {
  const verdict = await $.tool.check({ tool: "PowerShell", input: { command: "Get-Date" } });

  expect(verdict).toEqual({
    decision: "deny",
    reason: "OMCA's Bash guard failed, so the command was refused: no implementation for tool.check",
  });
});

test("the deny catch covers the two shell tools alone: another tool's failed check is not turned into a deny", async ($) => {
  await expect($.tool.check({ tool: "Read", input: { file_path: "a.md" } })).rejects.toThrow(
    /no implementation for tool.check/,
  );
  await expect($.tool.check({ tool: "PowerShellX", input: { command: "Get-Date" } })).rejects.toThrow(
    /no implementation for tool.check/,
  );
});

test("each passthrough dispatcher calls next once and returns its answer", async ($, on) => {
  const calls: string[] = [];
  on("session.start", () => (calls.push("session.start"), { cwd: "/engine" }));
  on("turn.start", (_$, e) => (calls.push("turn.start"), { turnId: e.turnId }));
  on("turn.complete", (_$, e) => (calls.push("turn.complete"), { text: `${e.answer}!` }));
  on("agent.spawn", () => (calls.push("agent.spawn"), { model: "claude-sonnet-5-5", agentId: "a-1" }));
  on("session.compact", (_$, e) => (calls.push("session.compact"), { messages: e.messages.slice(-1) }));
  on("ui.focus", () => (calls.push("ui.focus"), {}));
  on("ui.scroll", () => (calls.push("ui.scroll"), {}));
  on("command.run", (_$, e) => (calls.push(`command.run ${e.command} ${e.args}`), { text: "engine output" }));

  expect(await $.session.start({ cwd: "/work", surface: "terminal", isInteractive: true })).toEqual({ cwd: "/engine" });
  expect(await $.turn.start({ text: "hi", turnId: "t-1" })).toEqual({ turnId: "t-1" });
  expect(
    await $.turn.complete({ answer: "done", durationMs: 4, isAborted: false, turnId: "t-1", reason: "answer", agentId: "a-1" }),
  ).toEqual({ text: "done!" });
  expect(
    await $.agent.spawn({
      tool_use_id: "toolu_1",
      prompt: "Read README.md.",
      description: "read",
      subagentType: "general-purpose",
      provider: { plugin: "engine", tier: "core" },
      parentModel: "claude-opus-5-5",
      background: false,
      fork: false,
    }),
  ).toEqual({ model: "claude-sonnet-5-5", agentId: "a-1" });
  const kept: SessionMessage = { role: "assistant", text: "the plan is bound", toolUses: [] };
  expect(
    await $.session.compact({
      trigger: "manual",
      instructions: "keep the plan",
      messages: [{ role: "user", text: "start", toolUses: [] }, kept],
    }),
  ).toEqual({ messages: [kept] });
  expect(
    await $.ui.focus({ component: "Pane", requestId: "omca", element: "row-1", origin: { kind: "person" } }),
  ).toEqual({});
  expect(
    await $.ui.scroll({ component: "Pane", requestId: "omca", offset: 0, by: 1, bodyRows: 8, contentRows: 20, origin: { kind: "person" } }),
  ).toEqual({});
  expect(await $.command.run({ ...RUN, command: "omca", args: "" })).toEqual({ text: "engine output" });
  expect(await $.command.run({ ...RUN, command: "omca", args: "plan my-plan" })).toEqual({ text: "engine output" });
  expect(calls).toEqual([
    "session.start",
    "turn.start",
    "turn.complete",
    "agent.spawn",
    "session.compact",
    "ui.focus",
    "ui.scroll",
    "command.run omca ",
    "command.run omca plan my-plan",
  ]);
});

test("the turn.step dispatcher streams every chunk and returns the response", async ($, on) => {
  const requests: unknown[] = [];
  on("turn.step", async function* (_$, e) {
    requests.push(e);
    yield { kind: "text", index: 0, text: "he" };
    yield { kind: "text", index: 0, text: "llo" };
    return { turnId: e.turnId, index: e.index, answer: "hello", toolUses: [], stopReason: "end_turn", usage: null };
  });

  const stream = $.turn.step({ turnId: "t-1", index: 0, model: "claude-opus-5-5", effort: "high", messageCount: 1 });
  const texts: string[] = [];
  let step = await stream.next();
  while (step.done !== true) {
    if (step.value.kind === "text") texts.push(step.value.text);
    step = await stream.next();
  }

  expect(texts).toEqual(["he", "llo"]);
  expect(step.value).toEqual({ turnId: "t-1", index: 0, answer: "hello", toolUses: [], stopReason: "end_turn", usage: null });
  expect(requests).toEqual([{ turnId: "t-1", index: 0, model: "claude-opus-5-5", effort: "high", messageCount: 1 }]);
});

test("the band and pane render dispatchers fall through to the engine's drawing while their features draw nothing", async ($, on) => {
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: [`engine ${e.component}`] });
  });

  const band = await $.ui.mount({
    plugin: PLUGIN,
    surface: "terminal",
    component: "AbovePrompt",
    requestId: "band",
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 9 },
      view: {},
    },
  });
  expect(await band.find({ type: "Text", text: "engine AbovePrompt" })).toBeDefined();
  await band.unmount();

  const pane = await $.ui.mount({
    plugin: PLUGIN,
    surface: "terminal",
    component: "Pane",
    requestId: "elsewhere",
    props: {
      title: "omca",
      isFocused: true,
      bodyColumns: 70,
      placement: "dock",
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    },
  });
  expect(await pane.find({ type: "Text", text: "engine Pane" })).toBeDefined();
  await pane.unmount();
});

test("/omca answers an unknown subcommand with its usage and runs no command", async ($, on) => {
  const calls: string[] = [];
  on("command.run", (_$, e) => (calls.push(e.args), { text: "engine output" }));

  expect(await $.command.run({ ...RUN, command: "omca", args: "statz" })).toEqual({
    text: `Unknown /omca subcommand "statz". ${USAGE}`,
  });
  expect(calls).toEqual([]);
});

test("the router splits the first word from the rest and keeps the rest verbatim", async () => {
  expect(split("")).toEqual({ name: "", rest: "" });
  expect(split("   ")).toEqual({ name: "", rest: "" });
  expect(split("stats")).toEqual({ name: "stats", rest: "" });
  expect(split("  plan  ~/plans/my  plan.md ")).toEqual({ name: "plan", rest: "~/plans/my  plan.md" });
  expect(split("doctor\tnow")).toEqual({ name: "doctor", rest: "now" });
});

test("options default to a shown band and the dialog guard, and take the stored values", async () => {
  expect(readOptions({})).toEqual({ showBand: true, guardMode: "dialog", enableKeywordTriggers: false });
  expect(readOptions({ showBand: false, guardMode: "deny", enableKeywordTriggers: true })).toEqual({
    showBand: false,
    guardMode: "deny",
    enableKeywordTriggers: true,
  });
  expect(readOptions({ showBand: "false", guardMode: "DENY", enableKeywordTriggers: "true" })).toEqual({
    showBand: true,
    guardMode: "dialog",
    enableKeywordTriggers: false,
  });
});
