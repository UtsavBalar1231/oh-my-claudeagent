#!/usr/bin/env bun
// One headless `claude -p` turn per hook family, scripted through the mock model, with the
// packaged plugin loaded and again without it as a control. A plugin run asserts the omca_hook
// call per event (the server's own trace, matched against the client's `--debug-file` count of
// mcp_tool calls) and the mod's `tool.check` verdict line; the control asserts the same
// scenario shows none of it and the scripted effect happens unguarded.
//
// The sessions run in bypassPermissions: under auto mode the classifier would send its own
// requests to the mock and consume scripted turns. The mod's tool.check guard runs in both
// modes. Events that need a slash command (UserPromptExpansion, SessionStart on clear or
// compact) are not driven here; TaskCompleted runs with the task tools switched on.
//
// Usage: bun scripts/qa/hook-live-probe.ts
// Exit: 0 pass, 1 a check failed, 2 the run could not be set up.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EVIDENCE_LOG_TOOL } from "../../src/core/verification.ts";
import type { Run } from "../validate/core.ts";
import {
  type AccessEntry,
  CANARY,
  type Checks,
  call,
  guardDenies,
  hookCalls,
  localhostOnly,
  pluginDenies,
  type Qa,
  readJsonLines,
  runClaude,
  runQa,
  say,
  startMock,
  type TraceEntry,
  traceCount,
} from "./lib.ts";
import type { Script, Turn } from "./mock-model.ts";

type Observed = {
  project: string;
  trace: TraceEntry[];
  debug: string;
  clientCalls: number;
};

type Family = {
  name: string;
  script: (project: string) => Script;
  seed?: (project: string) => void;
  env?: Record<string, string>;
  plugin: (checks: Checks, o: Observed, label: string) => void;
  control: (checks: Checks, o: Observed, label: string) => void;
};

const bash = (command: string): Turn => call("Bash", { command, description: "probe command" });


/** Each delegation's `evidence_logged`, in the order the delegations started. */
function delegationEvidence(project: string): unknown[] {
  const dir = join(project, ".omca", "metrics");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((session) => readdirSync(join(dir, session)).map((file) => JSON.parse(readFileSync(join(dir, session, file), "utf8"))))
    .toSorted((a, b) => String(a.started_at).localeCompare(String(b.started_at)))
    .map((record) => record.evidence_logged);
}

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
      const denials = pluginDenies(o.debug);
      checks.check(denials.length === 1 && guardDenies(o.debug, "Bash").length === 1, `${label}: the mod's tool.check guard denied the recursive removal and nothing else`, `${label}: expected exactly one tool.check deny from the Bash guard, saw ${JSON.stringify(denials)}`);
      checks.check(!existsSync(join(o.project, CANARY, "decoy.txt")), `${label}: non-recursive rm still ran`, `${label}: ${CANARY}/decoy.txt is still present, so the guard denied a command it must not touch or the turn never ran it`);
      checks.check(existsSync(join(o.project, CANARY, "stale.o")), `${label}: ${CANARY}/stale.o survived the destructive command`, `${label}: ${CANARY}/stale.o was removed despite the deny`);
    },
    control(checks, o, label) {
      noPluginTrace(checks, o, label);
      checks.check(pluginDenies(o.debug).length === 0, `${label}: no guard deny without the plugin`, `${label}: a guard deny line appeared without the plugin`);
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
    // The completing agent answers for its own runs: a subagent's unlogged build must not hold
    // the main conversation's task, and a subagent's evidence must not cover the main one's run.
    name: "TaskCompleted attribution",
    script: () => ({
      main: [
        call("TaskCreate", { subject: "first", description: "probe one" }),
        call("TaskCreate", { subject: "second", description: "probe two" }),
        call("Agent", { description: "probe-alpha", prompt: "probe-alpha", subagent_type: "general-purpose" }),
        say("launched alpha"),
        call("TaskUpdate", { taskId: "1", status: "completed" }),
        bash("bun run build"),
        call("Agent", { description: "probe-beta", prompt: "probe-beta", subagent_type: "general-purpose" }),
        say("launched beta"),
        call("TaskUpdate", { taskId: "2", status: "completed" }),
        call(EVIDENCE_LOG_TOOL, { evidence_type: "build", command: "bun run build", exit_code: 0, output_snippet: "ok" }),
        call("TaskUpdate", { taskId: "2", status: "completed" }),
        say("done"),
      ],
      subagent: [],
      agents: {
        "probe-alpha": [bash("bun run build"), say("alpha done")],
        "probe-beta": [call(EVIDENCE_LOG_TOOL, { evidence_type: "build", command: "bun run build", exit_code: 0, output_snippet: "ok" }), say("beta done")],
      },
    }),
    seed: (project) => seedFile(project, "package.json", '{"scripts":{"build":"echo ok"}}\n'),
    env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" },
    plugin(checks, o, label) {
      const outputs = o.trace.filter((e) => e.event === "TaskCompleted").map((e) => e.output);
      checks.check(
        JSON.stringify(outputs) === JSON.stringify(["empty", "block", "empty"]),
        `${label}: a subagent's run held nothing, a subagent's evidence covered nothing, and the main conversation's own evidence released its task`,
        `${label}: TaskCompleted answered ${JSON.stringify(outputs)}, expected ["empty","block","empty"]`,
      );
      const logged = delegationEvidence(o.project);
      checks.check(
        JSON.stringify(logged) === JSON.stringify([false, true]),
        `${label}: only the delegation that called evidence_log is recorded as having logged evidence`,
        `${label}: delegation records say evidence_logged ${JSON.stringify(logged)} in start order, expected [false,true]`,
      );
    },
    control(checks, o, label) {
      noPluginTrace(checks, o, label);
    },
  },
];

async function observe({ scratch, checks }: Qa, family: Family, pluginDir: string | undefined, label: string): Promise<Observed> {
  const project = scratch.project();
  family.seed?.(project);
  const logDir = scratch.dir("log");
  const script = family.script(project);
  const expected = script.main.length;
  const mock = startMock(join(logDir, "access.log"), script);
  let result: Run;
  try {
    result = await runClaude({
      cwd: project,
      prompt: "run the probe",
      plugins: pluginDir === undefined ? [] : [pluginDir],
      port: mock.port,
      configDir: scratch.dir("config"),
      debugFile: join(logDir, "debug.log"),
      hookTrace: true,
      ...(family.env !== undefined && { env: family.env }),
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
    clientCalls: hookCalls(debug),
  };
}

function checkSessionEvents(checks: Checks, o: Observed, label: string): void {
  const stopGates = o.trace.filter((e) => e.event === "Stop" && e.output === "continue").length;
  checks.check(traceCount(o.trace, "UserPromptSubmit") >= 1, `${label}: UserPromptSubmit reached omca_hook`, `${label}: no UserPromptSubmit entry in the trace`);
  checks.check(traceCount(o.trace, "Stop") >= 1 && stopGates === 0, `${label}: Stop reached omca_hook and did not continue the turn with no open task`, `${label}: Stop entries ${traceCount(o.trace, "Stop")}, gate firings ${stopGates}`);
  checks.check(o.clientCalls === o.trace.length && o.clientCalls > 0, `${label}: the client's ${o.clientCalls} mcp_tool calls all reached the server`, `${label}: the client made ${o.clientCalls} mcp_tool calls and the server traced ${o.trace.length}`);
}

if (import.meta.main) {
  await runQa(
    "hook-live-probe",
    async (qa) => {
      const pluginDir = qa.scratch.plugin();
      for (const family of FAMILIES) {
        const withPlugin = `${family.name} [plugin]`;
        const o = await observe(qa, family, pluginDir, withPlugin);
        checkSessionEvents(qa.checks, o, withPlugin);
        family.plugin(qa.checks, o, withPlugin);

        const withoutPlugin = `${family.name} [control]`;
        family.control(qa.checks, await observe(qa, family, undefined, withoutPlugin), withoutPlugin);
      }
    },
    { watchRealConfig: true },
  );
}
