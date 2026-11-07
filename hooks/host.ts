import type { EngineInterface, PluginState, SessionMessage, Settings, SettingsReadArgs, StateRead, StateSetOptions, StateSetResult } from "claude-code";
import { LEDGER } from "../src/core/omca-paths.ts";
import { configDir, type Env as PathEnv, homeDir, inferPlatform, type Platform } from "../src/core/path.ts";
import { type GlyphTier, glyphTier } from "../src/core/ui-kit.ts";

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
    CLAUDE_CODE_TASK_LIST_ID: Env;
    CLAUDE_CODE_ENABLE_TODO_TOOLS: Env;
    CLAUDE_CODE_ENABLE_TASKS: Env;
    OMCA_GLYPHS: Env;
    OMCA_DISABLED_HOOKS: Env;
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: Env;
    CLAUDE_CODE_DISABLE_ADVISOR_TOOL: Env;
    DISABLE_TELEMETRY: Env;
    DO_NOT_TRACK: Env;
    DISABLE_GROWTHBOOK: Env;
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: Env;
    CLAUDE_CODE_EFFORT_LEVEL: Env;
    CLAUDE_AFK_TIMEOUT_MS: Env;
  };
  fs: {
    read: (path: string) => Promise<string>;
    write: Engine["fs"]["write"];
    stat: Engine["fs"]["stat"];
    list: Engine["fs"]["list"];
    exists: Engine["fs"]["exists"];
  };
  process: { run: Engine["process"]["run"] };
  mcp: { connect: Engine["mcp"]["connect"] };
  ui: {
    say: (text: string) => void;
    open: Engine["ui"]["open"];
    panes: Engine["ui"]["panes"];
    ask: Engine["ui"]["ask"];
    invalidate: () => void;
    focus: Engine["ui"]["focus"];
    resolve: Engine["ui"]["resolve"];
    copy: Engine["ui"]["copy"];
    toast: Engine["ui"]["toast"];
    blit: Engine["ui"]["blit"];
    view: Engine["ui"]["view"];
    status: Engine["ui"]["status"];
  };
  session: {
    id: Engine["session"]["id"];
    root: Engine["session"]["root"];
    cwd: Engine["session"]["cwd"];
    surfaces: Engine["session"]["surfaces"];
    usage: Engine["session"]["usage"];
    version: Engine["session"]["version"];
    transcript: (args: { agentId: string }) => Promise<SessionMessage[] | { deny: string }>;
  };
  settings: { read: (args?: Pick<SettingsReadArgs, "source">) => Promise<Settings> };
  tool: { list: Engine["tool"]["list"] };
  enableTaskTools: () => ReturnType<Engine["env"]["set"]>;
  nameTaskList: (id: string) => ReturnType<Engine["env"]["set"]>;
  agent: { list: Engine["agent"]["list"] };
  command: { register: Engine["command"]["register"] };
  clock: {
    now: Engine["clock"]["now"];
    after: Engine["clock"]["after"];
    every: Engine["clock"]["every"];
  };
  prompt: { fill: Engine["prompt"]["fill"]; submit: Engine["prompt"]["submit"]; read: Engine["prompt"]["read"]; paint: Engine["prompt"]["paint"] };
  state: { [K in keyof State]: AtomHost<K> };
};

// A write that loses its version means another landed, so a burst of n writers settles within n - 1
// retries. Up to 20 subagents spawn at once, each also stepping; the bound only stops a runaway engine.
const WRITE_ATTEMPTS = 64;

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

export type Session = { env: PathEnv; platform: Platform; home: string; config: string | undefined; glyphTier: GlyphTier };

const UNRESOLVED: Session = { env: {}, platform: "linux", home: "", config: undefined, glyphTier: "nerd" };
let session: Session | undefined;

async function resolveSession(host: Host): Promise<Session> {
  const [root, HOME, USERPROFILE, HOMEDRIVE, HOMEPATH, CLAUDE_CONFIG_DIR, glyphs] = await Promise.all([
    host.session.root(),
    host.env.HOME(),
    host.env.USERPROFILE(),
    host.env.HOMEDRIVE(),
    host.env.HOMEPATH(),
    host.env.CLAUDE_CONFIG_DIR(),
    host.env.OMCA_GLYPHS(),
  ]);
  const env = { HOME, USERPROFILE, HOMEDRIVE, HOMEPATH, CLAUDE_CONFIG_DIR };
  const home = homeDir(env) ?? "";
  const config = configDir(env);
  return { env, platform: inferPlatform(root, home, config ?? ""), home, config, glyphTier: glyphTier(glyphs) };
}

// The environment holds for the life of the session, so it is read once, outside any drawing.
export async function sessionOf(host: Host): Promise<Session> {
  session ??= await resolveSession(host);
  return session;
}

/** What `sessionOf` resolved, for a drawing that must not wait on the engine. */
export const resolvedSession = (): Session => session ?? UNRESOLVED;

/**
 * Puts `text` in the prompt box. Where the box does not take it, as on a surface that draws its
 * own composer, a toast carries the text so the person can type it.
 */
export async function fillPrompt(host: Host, text: string): Promise<void> {
  const { isFilled, refusal } = await host.prompt.fill({ text });
  if (isFilled) return;
  host.ui.toast(refusal === "dialog" ? `Close the open dialog, then type: ${text}` : `The prompt box cannot be filled here. Type: ${text}`);
}

/** The evidence ledger's modification time in whole seconds, 0 when there is none. */
export async function ledgerWrittenAt(host: Host, root: string): Promise<number> {
  const path = `${root}/${LEDGER}`;
  return (await host.fs.exists(path)) ? Math.floor((await host.fs.stat(path)).mtimeMs / 1000) : 0;
}

/** `mtimeMs:size`, or `absent` when the file cannot be stated. */
export const stampOf = (host: Host, path: string): Promise<string> =>
  host.fs.stat(path).then(
    ({ mtimeMs, size }) => `${mtimeMs}:${size}`,
    () => "absent",
  );
