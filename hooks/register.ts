import type { EngineInterface, EventResult, PluginOptions, Register } from "claude-code";
import { agentRows } from "./agent-rows.ts";
import { agentsTracker } from "./agents-tracker.ts";
import { band } from "./band.ts";
import { bashGuard } from "./bash-guard.ts";
import { blockerRows } from "./blocker-rows.ts";
import { briefRows } from "./brief-rows.ts";
import { completion } from "./completion.ts";
import { dispatch, dispatchStream, featuresFor } from "./dispatch.ts";
import { footer } from "./footer.ts";
import { keywordPaint } from "./keyword-paint.ts";
import type { Host, Options } from "./host.ts";
import { metrics } from "./metrics.ts";
import { modMarker } from "./mod-marker.ts";
import { notify } from "./notify.ts";
import { router } from "./omca-router.ts";
import { refusalRecovery } from "./refusal-recovery.ts";
import { pane } from "./pane.ts";
import { projectRoot } from "./project-root.ts";
import { groupRows } from "./group-rows.ts";
import { serverCheck } from "./server-check.ts";
import { TASK_COMMAND, taskList } from "./task-list.ts";
import { taskRows } from "./task-rows.ts";
import { taskTools } from "./task-tools.ts";

function bindHost($: EngineInterface, options: Options): Host {
  return {
    options,
    plugin: { name: $.plugin.name, root: $.plugin.root },
    log: (text) => $.ui.log(text, { to: "debug" }),
    env: {
      HOME: () => $.env.get("HOME"),
      USERPROFILE: () => $.env.get("USERPROFILE"),
      HOMEDRIVE: () => $.env.get("HOMEDRIVE"),
      HOMEPATH: () => $.env.get("HOMEPATH"),
      CLAUDE_CONFIG_DIR: () => $.env.get("CLAUDE_CONFIG_DIR"),
      CLAUDE_CODE_TASK_LIST_ID: () => $.env.get("CLAUDE_CODE_TASK_LIST_ID"),
      CLAUDE_CODE_ENABLE_TODO_TOOLS: () => $.env.get("CLAUDE_CODE_ENABLE_TODO_TOOLS"),
      CLAUDE_CODE_ENABLE_TASKS: () => $.env.get("CLAUDE_CODE_ENABLE_TASKS"),
      OMCA_GLYPHS: () => $.env.get("OMCA_GLYPHS"),
      OMCA_DISABLED_HOOKS: () => $.env.get("OMCA_DISABLED_HOOKS"),
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: () => $.env.get("CLAUDE_CODE_SUBAGENT_MODEL_FORCE"),
      CLAUDE_CODE_DISABLE_ADVISOR_TOOL: () => $.env.get("CLAUDE_CODE_DISABLE_ADVISOR_TOOL"),
      DISABLE_TELEMETRY: () => $.env.get("DISABLE_TELEMETRY"),
      DO_NOT_TRACK: () => $.env.get("DO_NOT_TRACK"),
      CLAUDE_CODE_DISABLE_FEATURE_FLAGS: () => $.env.get("CLAUDE_CODE_DISABLE_FEATURE_FLAGS"),
      DISABLE_GROWTHBOOK: () => $.env.get("DISABLE_GROWTHBOOK"),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: () => $.env.get("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"),
      CLAUDE_CODE_EFFORT_LEVEL: () => $.env.get("CLAUDE_CODE_EFFORT_LEVEL"),
      CLAUDE_AFK_TIMEOUT_MS: () => $.env.get("CLAUDE_AFK_TIMEOUT_MS"),
    },
    fs: {
      read: (path) => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      stat: (path, options) => $.fs.stat(path, options),
      list: (path) => $.fs.list(path),
      exists: (path) => $.fs.exists(path),
    },
    process: { run: (argv, init) => $.process.run(argv, init) },
    mcp: { connect: (server) => $.mcp.connect(server) },
    ui: {
      say: (text) => $.ui.log(text),
      open: (args) => $.ui.open(args),
      panes: () => $.ui.panes(),
      ask: (question, choices) => $.ui.ask(question, choices),
      invalidate: () => $.ui.invalidate("ui.render"),
      focus: (args) => $.ui.focus(args),
      resolve: (e) => $.ui.resolve(e),
      copy: (args) => $.ui.copy(args),
      toast: (text, toastOptions) => $.ui.toast(text, toastOptions),
      notify: (text, options) => $.ui.notify(text, options),
      cancelNotify: (key) => $.ui.cancelNotify(key),
      blit: (args) => $.ui.blit(args),
      view: (args) => $.ui.view(args),
      status: (text) => $.ui.status(text),
      place: (args) => $.ui.place(args),
    },
    session: {
      id: () => $.session.id(),
      // The omca server names its root by `git rev-parse --show-toplevel`; a launch from a subdirectory must find the same `.omca/`.
      root: () => $.session.root().then((started) => projectRoot(started, (argv, init) => $.process.run(argv, init))),
      cwd: () => $.session.cwd(),
      surfaces: () => $.session.surfaces(),
      usage: (args) => $.session.usage(args),
      version: () => $.session.version(),
      transcript: (args) => $.session.messages(args),
    },
    settings: { read: (args) => $.settings.read(args) },
    tool: { list: () => $.tool.list() },
    enableTaskTools: () => $.env.set("CLAUDE_CODE_ENABLE_TODO_TOOLS", "1"),
    nameTaskList: (id) => $.env.set("CLAUDE_CODE_TASK_LIST_ID", id),
    agent: { list: () => $.agent.list() },
    command: { register: (spec) => $.command.register(spec) },
    clock: {
      now: () => $.clock.now(),
      after: (ms, fn) => $.clock.after(ms, fn),
      every: (ms, fn) => $.clock.every(ms, fn),
    },
    prompt: {
      fill: (args) => $.prompt.fill(args),
      submit: (args) => $.prompt.submit(args),
      read: () => $.prompt.read(),
      paint: (args) => $.prompt.paint(args),
    },
    state: {
      agents: {
        get: () => $.state.get({ plugin: "oh-my-claudeagent", key: "agents" }),
        set: (value, setOptions) => $.state.set({ plugin: "oh-my-claudeagent", key: "agents" }, value, setOptions),
      },
      lanes: {
        get: () => $.state.get({ plugin: "oh-my-claudeagent", key: "lanes" }),
        set: (value, setOptions) => $.state.set({ plugin: "oh-my-claudeagent", key: "lanes" }, value, setOptions),
      },
      nextActions: {
        get: () => $.state.get({ plugin: "oh-my-claudeagent", key: "nextActions" }),
        set: (value, setOptions) =>
          $.state.set({ plugin: "oh-my-claudeagent", key: "nextActions" }, value, setOptions),
      },
      band: {
        get: () => $.state.get({ plugin: "oh-my-claudeagent", key: "band" }),
        set: (value, setOptions) => $.state.set({ plugin: "oh-my-claudeagent", key: "band" }, value, setOptions),
      },
      pane: {
        get: () => $.state.get({ plugin: "oh-my-claudeagent", key: "pane" }),
        set: (value, setOptions) => $.state.set({ plugin: "oh-my-claudeagent", key: "pane" }, value, setOptions),
      },
      tasks: {
        get: () => $.state.get({ plugin: "oh-my-claudeagent", key: "tasks" }),
        set: (value, setOptions) => $.state.set({ plugin: "oh-my-claudeagent", key: "tasks" }, value, setOptions),
      },
      placedRows: {
        get: () => $.state.get({ plugin: "oh-my-claudeagent", key: "placedRows" }),
        set: (value, setOptions) => $.state.set({ plugin: "oh-my-claudeagent", key: "placedRows" }, value, setOptions),
      },
      ledger: {
        get: () => $.state.get({ plugin: "oh-my-claudeagent", key: "ledger" }),
        set: (value, setOptions) => $.state.set({ plugin: "oh-my-claudeagent", key: "ledger" }, value, setOptions),
      },
      stats: {
        get: () => $.state.get({ plugin: "oh-my-claudeagent", key: "stats" }),
        set: (value, setOptions) => $.state.set({ plugin: "oh-my-claudeagent", key: "stats" }, value, setOptions),
      },
      costSample: {
        get: () => $.state.get({ plugin: "oh-my-claudeagent", key: "costSample" }),
        set: (value, setOptions) =>
          $.state.set({ plugin: "oh-my-claudeagent", key: "costSample" }, value, setOptions),
      },
      notices: {
        get: () => $.state.get({ plugin: "oh-my-claudeagent", key: "notices" }),
        set: (value, setOptions) => $.state.set({ plugin: "oh-my-claudeagent", key: "notices" }, value, setOptions),
      },
      turns: {
        get: () => $.state.get({ plugin: "oh-my-claudeagent", key: "turns" }),
        set: (value, setOptions) => $.state.set({ plugin: "oh-my-claudeagent", key: "turns" }, value, setOptions),
      },
      doctor: {
        get: () => $.state.get({ plugin: "oh-my-claudeagent", key: "doctor" }),
        set: (value, setOptions) => $.state.set({ plugin: "oh-my-claudeagent", key: "doctor" }, value, setOptions),
      },
      agentPage: {
        get: () => $.state.get({ plugin: "oh-my-claudeagent", key: "agentPage" }),
        set: (value, setOptions) => $.state.set({ plugin: "oh-my-claudeagent", key: "agentPage" }, value, setOptions),
      },
      pages: {
        get: () => $.state.get({ plugin: "oh-my-claudeagent", key: "pages" }),
        set: (value, setOptions) => $.state.set({ plugin: "oh-my-claudeagent", key: "pages" }, value, setOptions),
      },
    },
  };
}

export function readOptions(options: PluginOptions): Options {
  return {
    showBand: options["showBand"] !== false,
    guardMode: options["guardMode"] === "deny" ? "deny" : "dialog",
    enableKeywordTriggers: options["enableKeywordTriggers"] === true,
  };
}

const guardFailed = (reason: string): EventResult<"tool.check"> => ({
  decision: "deny",
  reason: `OMCA's Bash guard failed, so the command was refused: ${reason}`,
});

export const register: Register = (on, pluginOptions) => {
  const options = readOptions(pluginOptions);
  const bash = featuresFor("tool.check", { bashGuard });
  const toolCall = featuresFor("tool.call", { agentsTracker });
  const taskCall = featuresFor("tool.call", { taskList });
  const sendCall = featuresFor("tool.call", { briefRows });
  const sessionStart = featuresFor("session.start", { taskTools, refusalRecovery, pane, modMarker, band, serverCheck, keywordPaint, taskList });
  const promptSubmit = featuresFor("prompt.submit", { refusalRecovery, keywordPaint });
  const turnStart = featuresFor("turn.start", { refusalRecovery, footer, modMarker, serverCheck, taskRows });
  const turnStep = featuresFor("turn.step", { metrics, agentsTracker, briefRows });
  const turnComplete = featuresFor("turn.complete", { agentsTracker, agentRows, metrics, pane, footer, refusalRecovery, taskList, band, taskRows, notify });
  const agentSpawn = featuresFor("agent.spawn", { agentsTracker, metrics, briefRows, notify });
  const promptEdit = featuresFor("prompt.edit", { band, refusalRecovery, keywordPaint });
  const promptChange = featuresFor("prompt.change", { band, keywordPaint });
  const promptAutocomplete = featuresFor("prompt.autocomplete", { completion });
  const paneClose = featuresFor("ui.close", { pane, taskList });
  const paneFocus = featuresFor("ui.focus", { pane, taskList });
  const paneScroll = featuresFor("ui.scroll", { pane, taskList });
  const omca = featuresFor("command.run", { router });
  const taskCommand = featuresFor("command.run", { taskList });
  const bandRender = featuresFor("ui.render AbovePrompt", { band });
  const paneRender = featuresFor("ui.render Pane", { pane, taskList });
  const turnRender = featuresFor("ui.render TurnDuration", { footer });
  const noticeRender = featuresFor("ui.render UserMessage", { agentRows, briefRows });
  const launchRender = featuresFor("ui.render ToolUse", { agentRows });
  const resultRender = featuresFor("ui.render ToolResult", { blockerRows });
  const groupRender = featuresFor("ui.render ToolGroup", { groupRows });
  const placedRender = featuresFor("ui.render Placed", { taskRows });

  on("tool.check", { tool: /^(?:Bash|PowerShell|Monitor)$/ }, ($, e, next) =>
    dispatch(bindHost($, options), "tool.check", bash, e, next, guardFailed),
  ).catch((_$, _e, next) => guardFailed(next.error.message ?? next.error.kind));
  on("tool.call", { agentId: /./ }, ($, e, next) => dispatch(bindHost($, options), "tool.call", toolCall, e, next)).catch((_$, e, next) => next(e));
  on("tool.call", { tool: /^Task(?:Create|Update)$/ }, ($, e, next) => dispatch(bindHost($, options), "tool.call", taskCall, e, next)).catch((_$, e, next) => next(e));
  on("tool.call", { tool: /^SendMessage$/ }, ($, e, next) => dispatch(bindHost($, options), "tool.call", sendCall, e, next)).catch((_$, e, next) => next(e));
  on("session.start", ($, e, next) => dispatch(bindHost($, options), "session.start", sessionStart, e, next));
  on("prompt.submit", ($, e, next) => dispatch(bindHost($, options), "prompt.submit", promptSubmit, e, next));
  on("turn.start", ($, e, next) => dispatch(bindHost($, options), "turn.start", turnStart, e, next));
  on("turn.step", async function* ($, e, next) {
    return yield* dispatchStream(bindHost($, options), "turn.step", turnStep, e, next);
  });
  on("turn.complete", ($, e, next) => dispatch(bindHost($, options), "turn.complete", turnComplete, e, next));
  on("agent.spawn", ($, e, next) => dispatch(bindHost($, options), "agent.spawn", agentSpawn, e, next)).catch((_$, e, next) => next(e));
  on("prompt.edit", ($, e, next) => dispatch(bindHost($, options), "prompt.edit", promptEdit, e, next));
  on("prompt.change", ($, e, next) => dispatch(bindHost($, options), "prompt.change", promptChange, e, next));
  on("prompt.autocomplete", ($, e, next) => dispatch(bindHost($, options), "prompt.autocomplete", promptAutocomplete, e, next));
  on("ui.close", ($, e, next) => dispatch(bindHost($, options), "ui.close", paneClose, e, next)).catch((_$, e, next) => next(e));
  on("ui.focus", ($, e, next) => dispatch(bindHost($, options), "ui.focus", paneFocus, e, next)).catch((_$, e, next) => next(e));
  on("ui.scroll", { component: "Pane" }, ($, e, next) =>
    dispatch(bindHost($, options), "ui.scroll", paneScroll, e, next),
  ).catch((_$, e, next) => next(e));
  on("command.run", { command: "omca" }, ($, e, next) =>
    dispatch(bindHost($, options), "command.run omca", omca, e, next),
  ).catch((_$, e, next) => next(e));
  on("command.run", { command: TASK_COMMAND }, ($, e, next) =>
    dispatch(bindHost($, options), "command.run", taskCommand, e, next),
  ).catch((_$, e, next) => next(e));
  on("ui.render", { component: "AbovePrompt" }, ($, e, next) =>
    dispatch(bindHost($, options), "ui.render AbovePrompt", bandRender, e, next),
  );
  on("ui.render", { component: "Pane" }, ($, e, next) =>
    dispatch(bindHost($, options), "ui.render Pane", paneRender, e, next),
  );
  on("ui.render", { component: "TurnDuration" }, ($, e, next) =>
    dispatch(bindHost($, options), "ui.render TurnDuration", turnRender, e, next),
  );
  on("ui.render", { component: "UserMessage" }, ($, e, next) =>
    dispatch(bindHost($, options), "ui.render UserMessage", noticeRender, e, next),
  );
  on("ui.render", { component: "ToolUse", props: { tool: "Agent" } }, ($, e, next) =>
    dispatch(bindHost($, options), "ui.render ToolUse", launchRender, e, next),
  );
  on("ui.render", { component: "ToolResult", props: { tool: /^(?:Bash|PowerShell|Monitor|TaskUpdate|Write|Edit)$/ } }, ($, e, next) =>
    dispatch(bindHost($, options), "ui.render ToolResult", resultRender, e, next),
  );
  on("ui.render", { component: "ToolGroup" }, ($, e, next) =>
    dispatch(bindHost($, options), "ui.render ToolGroup", groupRender, e, next),
  );
  on("ui.render", { component: "Placed", props: { plugin: "oh-my-claudeagent" } }, ($, e, next) =>
    dispatch(bindHost($, options), "ui.render Placed", placedRender, e, next),
  );
};
