#!/usr/bin/env bun
// One headless `claude -p` turn per hook family, scripted through the mock model, with the
// packaged plugin loaded and again without it as a control. A plugin run asserts the omca_hook
// call per event (the server's own trace, matched against the client's `--debug-file` count of
// mcp_tool calls) and the mod's `tool.check` verdict line; the control asserts the same
// scenario shows none of it and the scripted effect happens unguarded.
//
// The sessions run in bypassPermissions: under auto mode the classifier would send its own
// requests to the mock and consume scripted turns. The mod's tool.check guard runs in both
// modes. Events that need auto mode, a slash command or task tools (PermissionRequest,
// PermissionDenied, UserPromptExpansion, SessionStart on clear or compact, TaskCompleted) are
// not driven here.
//
// The Stop family binds the session to a plan with unchecked tasks. It asserts that the gate
// keeps the turn going as feedback, so the next model request carries the reason and the client
// raises no hook-error notice, and that the control, with no plugin, stops after one request.
//
// Usage: bun scripts/qa/hook-live-probe.ts
// Exit: 0 pass, 1 a check failed, 2 the run could not be set up.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AccessEntry,
  type BodyEntry,
  type Checks,
  type ClaudeResult,
  localhostOnly,
  parseJsonLines,
  type Qa,
  readJsonLines,
  runClaude,
  runQa,
  startMock,
  type TraceEntry,
  traceCount,
} from "./lib.ts";
import type { Script, Turn } from "./mock-model.ts";

const GUARD_DENY = /tool\.check Bash [^ ]+: .* -> deny by plugin oh-my-claudeagent: Destructive rm -rf blocked/;
const ANY_PLUGIN_DENY = /-> deny by plugin oh-my-claudeagent/;
const HOOK_CALL = /Hooks: mcp_tool calling plugin:oh-my-claudeagent:omca\/omca_hook/g;
const PLAN_DENY_MARKER = "PLAN-CHECKBOX-VERIFY";
const PLAN_WITHOUT_CHECKBOXES = "## Work Objectives\n\nSome text with no checkboxes.\n";
const CANARY = "stale-build-cache";
const STOP_SESSION = "5c1f0f6e-3a47-4d52-9b0e-7d1a2c8e4b91";
const STOP_PLAN = "# Plan\n\n## TODOs\n\n- [ ] 1. Write the parser\n- [ ] 2. Write the printer\n";
const STOP_CONTEXT = "Stop hook additional context: [PLAN CONTINUATION]";
const STOP_ERROR_KEY = "stop-hook-error";

type Observed = {
  project: string;
  trace: TraceEntry[];
  debug: string;
  clientCalls: number;
  stdout: string;
  bodies: BodyEntry[];
};

type Family = {
  name: string;
  script: (project: string) => Script;
  sessionId?: string;
  boundPlan?: boolean;
  controlServed?: number;
  seed?: (project: string) => void;
  plugin: (checks: Checks, o: Observed, label: string) => void;
  control: (checks: Checks, o: Observed, label: string) => void;
};

const call = (name: string, input: Record<string, unknown>): Turn => ({ content: [{ type: "tool_use", name, input }] });
const say = (text: string): Turn => ({ content: [{ type: "text", text }] });
const bash = (command: string): Turn => call("Bash", { command, description: "probe command" });

type Notice = { type?: string; subtype?: string; key?: string };

const hookErrorNotices = (stdout: string): Notice[] =>
  parseJsonLines<Notice>(stdout).filter((line) => line.type === "system" && line.subtype === "notification" && line.key === STOP_ERROR_KEY);

const sessionStatus = (project: string): string => {
  const dir = join(project, ".omca", "state", "session");
  return existsSync(dir) ? readdirSync(dir).map((name) => readFileSync(join(dir, name), "utf8")).join("\n") : "";
};

const seedFile = (project: string, relative: string, text: string): void => {
  mkdirSync(join(project, relative, ".."), { recursive: true });
  writeFileSync(join(project, relative), text);
};

function noPluginTrace(checks: Checks, o: Observed, label: string): void {
  checks.check(o.trace.length === 0 && o.clientCalls === 0, `${label}: no omca_hook call without the plugin`, `${label}: ${o.trace.length} omca_hook trace entries and ${o.clientCalls} client calls without the plugin`);
}

// The client's own critical-path check refuses a recursive removal of `./*` even in
// bypassPermissions, so a control run could never delete. The guard reads `"$CACHE"/` as a root
// directory, since the variable could be empty, and the client lets it through.
const FAMILIES: Family[] = [
  {
    name: "PreToolUse deny",
    script: (project) => ({ main: [call("Write", { file_path: join(project, "plans", "no-checkboxes.md"), content: PLAN_WITHOUT_CHECKBOXES }), say("done")], subagent: [] }),
    plugin(checks, o, label) {
      const denied = o.trace.some((e) => e.event === "PreToolUse" && e.tool_name === "Write" && e.output === "deny");
      checks.check(denied && o.debug.includes(PLAN_DENY_MARKER), `${label}: the plan-write guard denied the zero-checkbox plan write`, `${label}: no ${PLAN_DENY_MARKER} deny in the trace or the debug log`);
      checks.check(!existsSync(join(o.project, "plans", "no-checkboxes.md")), `${label}: the denied write did not land on disk`, `${label}: plans/no-checkboxes.md exists despite the deny`);
    },
    control(checks, o, label) {
      noPluginTrace(checks, o, label);
      checks.check(existsSync(join(o.project, "plans", "no-checkboxes.md")), `${label}: the same write lands on disk without the plugin`, `${label}: the write did not land without the plugin, so the scenario proves nothing`);
    },
  },
  {
    name: "PostToolUse injection",
    script: (project) => ({ main: [call("Write", { file_path: join(project, "notes.md"), content: "hello\n" }), say("done")], subagent: [] }),
    plugin(checks, o, label) {
      const injected = o.trace.some((e) => e.event === "PostToolUse" && e.tool_name === "Write" && e.output === "context");
      checks.check(injected && o.debug.includes("Prose rules"), `${label}: the Markdown prose rule was injected after a Write`, `${label}: no injected prose rule in the trace or the debug log`);
    },
    control(checks, o, label) {
      noPluginTrace(checks, o, label);
      checks.check(!o.debug.includes("Prose rules"), `${label}: no prose rule without the plugin`, `${label}: prose rule text appeared without the plugin`);
    },
  },
  {
    name: "PostToolUse recorder",
    script: () => ({ main: [bash("bun run build"), bash('bun -e "process.exit(3)"'), say("done")], subagent: [] }),
    seed: (project) => seedFile(project, "package.json", '{"scripts":{"build":"echo ok"}}\n'),
    plugin(checks, o, label) {
      checks.check(sessionStatus(o.project).includes("bun run build"), `${label}: the session status file names the verification command`, `${label}: no session status file names \`bun run build\``);
      checks.check(traceCount(o.trace, "PostToolUse", "Bash") >= 1, `${label}: PostToolUse reached omca_hook for the Bash call`, `${label}: no PostToolUse Bash entry in the trace`);
      checks.check(traceCount(o.trace, "PostToolUseFailure") >= 1, `${label}: PostToolUseFailure reached omca_hook for the failing Bash call`, `${label}: no PostToolUseFailure entry in the trace`);
    },
    control(checks, o, label) {
      noPluginTrace(checks, o, label);
      checks.check(sessionStatus(o.project) === "", `${label}: no session status file without the plugin`, `${label}: a session status file exists without the plugin`);
    },
  },
  {
    name: "Bash guard",
    script: () => ({ main: [bash(`rm ${CANARY}/decoy.txt`), bash(`CACHE="$PWD/${CANARY}"; rm -rf "$CACHE"/`), say("done")], subagent: [] }),
    seed(project) {
      seedFile(project, join(CANARY, "stale.o"), "stale artifact\n");
      seedFile(project, join(CANARY, "decoy.txt"), "decoy\n");
    },
    plugin(checks, o, label) {
      const denials = o.debug.split("\n").filter((line) => ANY_PLUGIN_DENY.test(line));
      checks.check(denials.length === 1 && GUARD_DENY.test(denials[0] ?? ""), `${label}: the mod's tool.check guard denied the recursive removal and nothing else`, `${label}: expected exactly one tool.check deny from the Bash guard, saw ${JSON.stringify(denials)}`);
      checks.check(!existsSync(join(o.project, CANARY, "decoy.txt")), `${label}: non-recursive rm still ran`, `${label}: ${CANARY}/decoy.txt is still present, so the guard denied a command it must not touch or the turn never ran it`);
      checks.check(existsSync(join(o.project, CANARY, "stale.o")), `${label}: ${CANARY}/stale.o survived the destructive command`, `${label}: ${CANARY}/stale.o was removed despite the deny`);
    },
    control(checks, o, label) {
      noPluginTrace(checks, o, label);
      checks.check(!ANY_PLUGIN_DENY.test(o.debug), `${label}: no guard deny without the plugin`, `${label}: a guard deny line appeared without the plugin`);
      checks.check(!existsSync(join(o.project, CANARY)), `${label}: the same command removes ${CANARY} without the plugin`, `${label}: ${CANARY} survived without the plugin, so the scenario proves nothing`);
    },
  },
  {
    name: "Agent",
    script: () => ({
      main: [call("Agent", { description: "probe", prompt: "say hi", subagent_type: "general-purpose" }), say("agent launched"), say("agent finished")],
      subagent: [say("hi from the subagent")],
    }),
    plugin(checks, o, label) {
      checks.check(traceCount(o.trace, "SubagentStart") >= 1, `${label}: SubagentStart reached omca_hook`, `${label}: no SubagentStart entry in the trace`);
      checks.check(traceCount(o.trace, "PostToolUse", "Agent") >= 1, `${label}: PostToolUse reached omca_hook for the Agent call`, `${label}: no PostToolUse Agent entry in the trace`);
    },
    control(checks, o, label) {
      noPluginTrace(checks, o, label);
    },
  },
  {
    name: "Stop continuation",
    sessionId: STOP_SESSION,
    boundPlan: true,
    controlServed: 1,
    script: () => ({ main: [say("working on the first task"), say("picked the plan back up")], subagent: [] }),
    seed(project) {
      const plan = join(project, "plans", "plan.md");
      seedFile(project, join("plans", "plan.md"), STOP_PLAN);
      const registry = {
        plans: { probe: { active_plan: plan, started_at: "2026-01-01T00:00:00Z", session_ids: [STOP_SESSION], agent: "sisyphus" } },
        bindings: { [STOP_SESSION]: { plan_name: "probe", bound_at: Math.floor(Date.now() / 1000) } },
      };
      seedFile(project, join(".omca", "state", "boulder.json"), JSON.stringify(registry));
    },
    plugin(checks, o, label) {
      const main = o.bodies.filter((entry) => entry.queue === "main" && entry.turn !== null);
      checks.check(
        main.length === 2 && !main[0]?.body.includes(STOP_CONTEXT) && main[1]?.body.includes(STOP_CONTEXT) === true,
        `${label}: the second main request carries the plan-continuation reason as Stop hook additional context`,
        `${label}: ${main.length} main requests, with the reason in ${JSON.stringify(main.map((entry) => entry.body.includes(STOP_CONTEXT)))}`,
      );
      const notices = hookErrorNotices(o.stdout);
      checks.check(
        o.stdout.includes('"subtype":"init"') && notices.length === 0,
        `${label}: the stream-json output carries no ${STOP_ERROR_KEY} notification`,
        `${label}: ${notices.length} ${STOP_ERROR_KEY} notifications in the stream-json output`,
      );
      const stops = o.trace.filter((entry) => entry.event === "Stop").map((entry) => entry.output);
      checks.check(stops.length === 2 && stops[0] === "continue" && stops[1] === "empty", `${label}: the gate fired once, then answered {} on the stop_hook_active retry`, `${label}: Stop trace outputs ${JSON.stringify(stops)}`);
    },
    control(checks, o, label) {
      noPluginTrace(checks, o, label);
      const main = o.bodies.filter((entry) => entry.queue === "main" && entry.turn !== null);
      checks.check(main.length === 1 && !o.bodies.some((entry) => entry.body.includes("[PLAN CONTINUATION]")), `${label}: the bound plan keeps nothing going without the plugin`, `${label}: ${main.length} main requests, or the reason reached the model, without the plugin`);
      checks.check(o.stdout.includes('"subtype":"init"') && hookErrorNotices(o.stdout).length === 0, `${label}: no ${STOP_ERROR_KEY} notification without the plugin`, `${label}: a ${STOP_ERROR_KEY} notification appeared without the plugin`);
    },
  },
];

async function observe({ scratch }: Qa, family: Family, pluginDir: string | undefined, label: string, checks: Checks): Promise<Observed> {
  const project = scratch.project();
  family.seed?.(project);
  const logDir = scratch.dir("log");
  const script = family.script(project);
  const expected = pluginDir === undefined ? (family.controlServed ?? script.main.length) : script.main.length;
  const bodyLog = join(logDir, "bodies.log");
  const mock = startMock(join(logDir, "access.log"), script, bodyLog);
  let result: ClaudeResult;
  try {
    result = await runClaude({
      cwd: project,
      prompt: "run the probe",
      plugins: pluginDir === undefined ? [] : [pluginDir],
      port: mock.port,
      configDir: scratch.dir("config"),
      debugFile: join(logDir, "debug.log"),
      hookTrace: true,
      streamJson: true,
      ...(family.sessionId === undefined ? {} : { sessionId: family.sessionId }),
    });
  } finally {
    await mock.stop();
  }
  const debugPath = join(logDir, "debug.log");
  const debug = existsSync(debugPath) ? readFileSync(debugPath, "utf8") : "";
  const entries = readJsonLines<AccessEntry>(mock.accessLog);
  const served = entries.filter((e) => e.queue === "main" && e.turn !== null).length;
  checks.check(result.code === 0, `${label}: claude -p exited 0`, `${label}: claude -p exited ${result.code}: ${(result.stdout + result.stderr).trim()}`);
  checks.check(served === expected && localhostOnly(entries), `${label}: the mock served all ${served} expected main turns to localhost only`, `${label}: the mock served ${served} of ${expected} expected main turns (entries ${entries.length})`);
  return {
    project,
    trace: readJsonLines<TraceEntry>(join(project, ".omca", "state", "hook-trace.jsonl")),
    debug,
    clientCalls: debug.match(HOOK_CALL)?.length ?? 0,
    stdout: result.stdout,
    bodies: readJsonLines<BodyEntry>(bodyLog),
  };
}

function checkSessionEvents(checks: Checks, o: Observed, label: string, boundPlan: boolean): void {
  const stopGates = o.trace.filter((e) => e.event === "Stop" && e.output === "continue").length;
  checks.check(traceCount(o.trace, "UserPromptSubmit") >= 1, `${label}: UserPromptSubmit reached omca_hook`, `${label}: no UserPromptSubmit entry in the trace`);
  if (boundPlan) checks.check(traceCount(o.trace, "Stop") >= 1, `${label}: Stop reached omca_hook`, `${label}: no Stop entry in the trace`);
  else checks.check(traceCount(o.trace, "Stop") >= 1 && stopGates === 0, `${label}: Stop reached omca_hook and did not continue the turn with no bound plan`, `${label}: Stop entries ${traceCount(o.trace, "Stop")}, gate firings ${stopGates}`);
  checks.check(o.clientCalls === o.trace.length && o.clientCalls > 0, `${label}: the client's ${o.clientCalls} mcp_tool calls all reached the server`, `${label}: the client made ${o.clientCalls} mcp_tool calls and the server traced ${o.trace.length}`);
}

if (import.meta.main) {
  await runQa(
    "hook-live-probe",
    async (qa) => {
      const pluginDir = qa.scratch.plugin();
      for (const family of FAMILIES) {
        const withPlugin = `${family.name} [plugin]`;
        const o = await observe(qa, family, pluginDir, withPlugin, qa.checks);
        checkSessionEvents(qa.checks, o, withPlugin, family.boundPlan === true);
        family.plugin(qa.checks, o, withPlugin);

        const withoutPlugin = `${family.name} [control]`;
        family.control(qa.checks, await observe(qa, family, undefined, withoutPlugin, qa.checks), withoutPlugin);
      }
    },
    { watchRealConfig: true },
  );
}
