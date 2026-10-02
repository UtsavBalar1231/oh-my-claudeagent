import type { EngineInterface, PluginState, StateRead, StateSetOptions, StateSetResult } from "claude-code";

export type State = PluginState["oh-my-claudeagent"];

export type AtomHost<K extends keyof State> = {
  get: () => Promise<StateRead<State[K]>>;
  set: (value: State[K], options?: StateSetOptions) => Promise<StateSetResult>;
};

export type Options = {
  showBand: boolean;
  guardMode: "dialog" | "deny";
  enableKeywordTriggers: boolean;
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
    panes: Engine["ui"]["panes"];
    ask: Engine["ui"]["ask"];
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

const WRITE_ATTEMPTS = 3;

// Several hooks write one atom between awaits, so each write is read, changed and set at the
// version it read. A change that returns the value unchanged writes nothing and redraws nothing.
export async function update<K extends keyof State>(
  atom: AtomHost<K>,
  change: (value: State[K] | undefined) => State[K] | undefined,
): Promise<void> {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const { value, version } = await atom.get();
    const next = change(value);
    if (next === undefined || next === value) return;
    if ((await atom.set(next, { ifVersion: version })).isSet) return;
  }
  throw new Error(`the state changed under ${WRITE_ATTEMPTS} writes in a row`);
}

// The engine prefixes a refused call's message with the plugin and the call, `<plugin>: $.fs.read: `.
export const reason = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^[\w-]+: \$\.[\w.]+: /, "");

export async function pluginVersion(host: Host): Promise<string | null> {
  try {
    const manifest: unknown = JSON.parse(await host.fs.read(`${host.plugin.root}/.claude-plugin/plugin.json`));
    const version = typeof manifest === "object" && manifest !== null && "version" in manifest ? manifest.version : null;
    return typeof version === "string" ? version : null;
  } catch (error) {
    host.log(`cannot read the plugin version: ${reason(error)}`);
    return null;
  }
}
