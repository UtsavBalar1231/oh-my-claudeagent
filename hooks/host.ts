import type { EngineInterface, PluginState, StateRead, StateSetOptions, StateSetResult } from "claude-code";
import { resolveBoundPlan } from "../src/core/boulder.ts";
import { BOULDER, LEDGER } from "../src/core/omca-paths.ts";
import { configDir, type Env as PathEnv, homeDir, inferPlatform, isAbsolutePath, joinPath, type Platform } from "../src/core/path.ts";
import { parseRuns, proofOf, type Run, type Verdict } from "../src/core/proof.ts";
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
    OMCA_GLYPHS: Env;
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
  mcp: { connect: Engine["mcp"]["connect"] };
  ui: {
    say: (text: string) => void;
    open: Engine["ui"]["open"];
    panes: Engine["ui"]["panes"];
    ask: Engine["ui"]["ask"];
    invalidate: () => void;
    focus: Engine["ui"]["focus"];
    resolve: Engine["ui"]["resolve"];
    selection: Engine["ui"]["selection"];
    copy: Engine["ui"]["copy"];
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

/** The plan this session is bound to, undefined when none is; throws when the registry does not parse. */
export async function boundPlanOf(host: Host): Promise<{ name: string; path: string } | undefined> {
  const [root, sessionId] = await Promise.all([host.session.root(), host.session.id()]);
  const registry = `${root}/${BOULDER}`;
  if (!(await host.fs.exists(registry))) return undefined;
  const plan = resolveBoundPlan(JSON.parse(await host.fs.read(registry)), sessionId, true);
  return plan === undefined || plan.active_plan === "" ? undefined : { name: plan.plan_name, path: plan.active_plan };
}

/** The evidence ledger's modification time in whole seconds, 0 when there is none. */
export async function ledgerWrittenAt(host: Host, root: string): Promise<number> {
  const path = `${root}/${LEDGER}`;
  return (await host.fs.exists(path)) ? Math.floor((await host.fs.stat(path)).mtimeMs / 1000) : 0;
}

/**
 * What proves a plan's tasks: each listed file's modification time, null for one that cannot be
 * stated, and the ledger's runs, or why the ledger could not be read. `ledgerSeen` changes when
 * the ledger does.
 */
export type ProofFacts = { changes: ReadonlyMap<string, number | null>; runs: readonly Run[]; ledgerError: string | null; ledgerSeen: string };

export async function proofFacts(host: Host, files: readonly string[]): Promise<ProofFacts> {
  const [root, { platform }] = await Promise.all([host.session.root(), sessionOf(host)]);
  const paths = [...new Set(files)];
  const stamps = await Promise.all(
    paths.map((path) =>
      host.fs.stat(isAbsolutePath(platform, path) ? path : joinPath(platform, root, path)).then(
        (stat) => (stat.kind === "file" ? stat.mtimeMs : null),
        () => null,
      ),
    ),
  );
  const ledgerPath = `${root}/${LEDGER}`;
  const ledgerSeen = await host.fs.stat(ledgerPath).then(
    ({ mtimeMs }) => String(mtimeMs),
    () => "absent",
  );
  let runs: Run[] = [];
  let ledgerError: string | null = null;
  if (ledgerSeen !== "absent") {
    try {
      runs = parseRuns(await host.fs.read(ledgerPath));
    } catch (error) {
      ledgerError = reason(error);
    }
  }
  return { changes: new Map(paths.map((path, index) => [path, stamps[index] ?? null])), runs, ledgerError, ledgerSeen };
}

/** A task's proof from the facts: undefined when the ledger is unreadable or none of its files can be stated. */
export function verdictFor(facts: ProofFacts, files: readonly string[]): Verdict | undefined {
  if (facts.ledgerError !== null) return undefined;
  return proofOf(
    files.flatMap((file) => {
      const at = facts.changes.get(file);
      return at === undefined || at === null ? [] : [at];
    }),
    facts.runs,
  );
}
