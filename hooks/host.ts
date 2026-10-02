import type { EngineInterface, PluginOptions, PluginState, StateRead, StateSetOptions, StateSetResult } from "claude-code";

export type State = PluginState["oh-my-claudeagent"];

export type AtomHost<K extends keyof State> = {
  get: () => Promise<StateRead<State[K]>>;
  set: (value: State[K], options?: StateSetOptions) => Promise<StateSetResult>;
};

export type Options = {
  showBand: boolean;
  guardMode: "dialog" | "deny";
  enableKeywordTriggers: boolean;
  raw: PluginOptions;
};

type Env = () => Promise<string | undefined>;
type Engine = EngineInterface;

export type Host = {
  options: Options;
  plugin: { name: string; root: string };
  log: (text: string) => void;
  env: {
    HOME: Env;
    USERPROFILE: Env;
    HOMEDRIVE: Env;
    HOMEPATH: Env;
    CLAUDE_CONFIG_DIR: Env;
    OMCA_ASCII: Env;
    OMCA_DISABLED_HOOKS: Env;
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: Env;
    CLAUDE_CODE_DISABLE_ADVISOR_TOOL: Env;
    DISABLE_TELEMETRY: Env;
    DO_NOT_TRACK: Env;
    DISABLE_GROWTHBOOK: Env;
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: Env;
  };
  fs: {
    read: (path: string) => Promise<string>;
    write: Engine["fs"]["write"];
    stat: Engine["fs"]["stat"];
    list: Engine["fs"]["list"];
    exists: Engine["fs"]["exists"];
  };
  process: { run: Engine["process"]["run"] };
  ui: {
    open: Engine["ui"]["open"];
    close: Engine["ui"]["close"];
    panes: Engine["ui"]["panes"];
    ask: Engine["ui"]["ask"];
    toast: Engine["ui"]["toast"];
    status: Engine["ui"]["status"];
    invalidate: () => void;
    focus: Engine["ui"]["focus"];
    resolve: Engine["ui"]["resolve"];
  };
  session: {
    id: Engine["session"]["id"];
    root: Engine["session"]["root"];
    cwd: Engine["session"]["cwd"];
    surfaces: Engine["session"]["surfaces"];
    usage: Engine["session"]["usage"];
    version: Engine["session"]["version"];
    model: Engine["session"]["model"];
  };
  settings: { read: Engine["settings"]["read"] };
  agent: { list: Engine["agent"]["list"] };
  command: { register: Engine["command"]["register"] };
  clock: {
    now: Engine["clock"]["now"];
    after: Engine["clock"]["after"];
    every: Engine["clock"]["every"];
  };
  prompt: { fill: Engine["prompt"]["fill"] };
  state: { [K in keyof State]: AtomHost<K> };
};
