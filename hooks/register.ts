import type { EngineInterface, EventResult, PluginOptions, Register } from "claude-code";
import { agentsTracker } from "./agents-tracker.ts";
import { band } from "./band.ts";
import { bashGuard } from "./bash-guard.ts";
import { compact } from "./compact.ts";
import { dispatch, dispatchStream, featuresFor } from "./dispatch.ts";
import { feedback } from "./feedback.ts";
import { footer } from "./footer.ts";
import type { Host, Options } from "./host.ts";
import { metrics } from "./metrics.ts";
import { modMarker } from "./mod-marker.ts";
import { router } from "./omca-router.ts";
import { pane } from "./pane.ts";
import { route } from "./route.ts";
import { serverCheck } from "./server-check.ts";
import { spinner } from "./spinner.ts";

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
      OMCA_GLYPHS: () => $.env.get("OMCA_GLYPHS"),
      OMCA_DISABLED_HOOKS: () => $.env.get("OMCA_DISABLED_HOOKS"),
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: () => $.env.get("CLAUDE_CODE_SUBAGENT_MODEL_FORCE"),
      CLAUDE_CODE_DISABLE_ADVISOR_TOOL: () => $.env.get("CLAUDE_CODE_DISABLE_ADVISOR_TOOL"),
      DISABLE_TELEMETRY: () => $.env.get("DISABLE_TELEMETRY"),
      DO_NOT_TRACK: () => $.env.get("DO_NOT_TRACK"),
      DISABLE_GROWTHBOOK: () => $.env.get("DISABLE_GROWTHBOOK"),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: () => $.env.get("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"),
    },
    fs: {
      read: (path) => $.fs.read(path),
      readBytes: (path) => $.fs.read(path, { as: "bytes" }),
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
      selection: () => $.ui.selection(),
      copy: (args) => $.ui.copy(args),
      toast: (text, toastOptions) => $.ui.toast(text, toastOptions),
      blit: (args) => $.ui.blit(args),
    },
    session: {
      id: () => $.session.id(),
      root: () => $.session.root(),
      cwd: () => $.session.cwd(),
      surfaces: () => $.session.surfaces(),
      usage: (args) => $.session.usage(args),
      version: () => $.session.version(),
      transcript: (args) => $.session.messages(args),
    },
    settings: { read: (args) => $.settings.read(args) },
    agent: { list: () => $.agent.list() },
    command: { register: (spec) => $.command.register(spec) },
    clock: {
      now: () => $.clock.now(),
      after: (ms, fn) => $.clock.after(ms, fn),
      every: (ms, fn) => $.clock.every(ms, fn),
    },
    prompt: { fill: (args) => $.prompt.fill(args) },
    state: {
      agents: {
        get: () => $.state.get({ plugin: "oh-my-claudeagent", key: "agents" }),
        set: (value, setOptions) => $.state.set({ plugin: "oh-my-claudeagent", key: "agents" }, value, setOptions),
      },
      lanes: {
        get: () => $.state.get({ plugin: "oh-my-claudeagent", key: "lanes" }),
        set: (value, setOptions) => $.state.set({ plugin: "oh-my-claudeagent", key: "lanes" }, value, setOptions),
      },
      routes: {
        get: () => $.state.get({ plugin: "oh-my-claudeagent", key: "routes" }),
        set: (value, setOptions) => $.state.set({ plugin: "oh-my-claudeagent", key: "routes" }, value, setOptions),
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
      ledger: {
        get: () => $.state.get({ plugin: "oh-my-claudeagent", key: "ledger" }),
        set: (value, setOptions) => $.state.set({ plugin: "oh-my-claudeagent", key: "ledger" }, value, setOptions),
      },
      plan: {
        get: () => $.state.get({ plugin: "oh-my-claudeagent", key: "plan" }),
        set: (value, setOptions) => $.state.set({ plugin: "oh-my-claudeagent", key: "plan" }, value, setOptions),
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
  const sessionStart = featuresFor("session.start", { pane, feedback, modMarker, band, serverCheck });
  const turnStart = featuresFor("turn.start", { footer, modMarker });
  const turnStep = featuresFor("turn.step", { route, metrics, agentsTracker });
  const turnComplete = featuresFor("turn.complete", { band, agentsTracker, metrics, pane, feedback, footer });
  const agentSpawn = featuresFor("agent.spawn", { route, agentsTracker, pane, metrics });
  const promptEdit = featuresFor("prompt.edit", { band });
  const paneClose = featuresFor("ui.close", { pane });
  const paneFocus = featuresFor("ui.focus", { pane });
  const paneScroll = featuresFor("ui.scroll", { pane });
  const omca = featuresFor("command.run", { router });
  const rate = featuresFor("command.run", { feedback });
  const bandRender = featuresFor("ui.render AbovePrompt", { band });
  const paneRender = featuresFor("ui.render Pane", { pane });
  const spinnerRender = featuresFor("ui.render Spinner", { spinner });
  const sessionCompact = featuresFor("session.compact", { compact });

  on("tool.check", { tool: /^(?:Bash|PowerShell)$/ }, ($, e, next) =>
    dispatch(bindHost($, options), "tool.check", bash, e, next, guardFailed),
  ).catch((_$, _e, next) => guardFailed(next.error.message ?? next.error.kind));
  on("tool.call", ($, e, next) => dispatch(bindHost($, options), "tool.call", toolCall, e, next));
  on("session.start", ($, e, next) => dispatch(bindHost($, options), "session.start", sessionStart, e, next));
  on("turn.start", ($, e, next) => dispatch(bindHost($, options), "turn.start", turnStart, e, next));
  on("turn.step", async function* ($, e, next) {
    return yield* dispatchStream(bindHost($, options), "turn.step", turnStep, e, next);
  });
  on("turn.complete", ($, e, next) => dispatch(bindHost($, options), "turn.complete", turnComplete, e, next));
  on("agent.spawn", ($, e, next) => dispatch(bindHost($, options), "agent.spawn", agentSpawn, e, next));
  on("prompt.edit", ($, e, next) => dispatch(bindHost($, options), "prompt.edit", promptEdit, e, next));
  on("ui.close", ($, e, next) => dispatch(bindHost($, options), "ui.close", paneClose, e, next));
  on("ui.focus", ($, e, next) => dispatch(bindHost($, options), "ui.focus", paneFocus, e, next));
  on("ui.scroll", { component: "Pane" }, ($, e, next) =>
    dispatch(bindHost($, options), "ui.scroll", paneScroll, e, next),
  );
  on("command.run", { command: "omca" }, ($, e, next) =>
    dispatch(bindHost($, options), "command.run omca", omca, e, next),
  );
  on("command.run", { command: "omca-rate" }, ($, e, next) =>
    dispatch(bindHost($, options), "command.run omca-rate", rate, e, next),
  );
  on("ui.render", { component: "AbovePrompt" }, ($, e, next) =>
    dispatch(bindHost($, options), "ui.render AbovePrompt", bandRender, e, next),
  );
  on("ui.render", { component: "Pane" }, ($, e, next) =>
    dispatch(bindHost($, options), "ui.render Pane", paneRender, e, next),
  );
  on("ui.render", { component: "Spinner" }, ($, e, next) =>
    dispatch(bindHost($, options), "ui.render Spinner", spinnerRender, e, next),
  );
  on("session.compact", ($, e, next) => dispatch(bindHost($, options), "session.compact", sessionCompact, e, next));
};
