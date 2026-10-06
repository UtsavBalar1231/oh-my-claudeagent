import { RENAMES } from "../src/core/agent-names.ts";
import { addRefreshInterval, doctorChecks, type Fix, type HookState, unifiedDiff } from "../src/core/doctor-checks.ts";
import { parseFrontmatter } from "../src/core/frontmatter.ts";
import { statusPath } from "../src/core/omca-paths.ts";
import { joinPath, type Platform, tildePath } from "../src/core/path.ts";
import { type Host, pluginVersion, reason, sessionOf, type State, update } from "./host.ts";

type Doctor = State["doctor"];

const RUN_TIMEOUT_MS = 10_000;
const REWRITE: Readonly<Record<Fix, (text: string) => string | undefined>> = {
  "add-refresh-interval": addRefreshInterval,
};

const seen = new Map<Fix, { path: string; text: string }>();
let isBusy = false;

const patch = (host: Host, change: Partial<Doctor>) =>
  update(host.state.doctor, (doctor) => ({
    isRunning: false,
    checks: [],
    applied: null,
    error: null,
    ranAt: 0,
    ...doctor,
    ...change,
  }));

async function where(host: Host): Promise<{ platform: Platform; home: string; settings: string | undefined }> {
  const { platform, home, config } = await sessionOf(host);
  return { platform, home, settings: config === undefined ? undefined : joinPath(platform, config, "settings.json") };
}

async function readIfPresent(host: Host, path: string): Promise<string | null> {
  return (await host.fs.exists(path)) ? host.fs.read(path) : null;
}

async function output(host: Host, argv: readonly string[]): Promise<string | null> {
  try {
    const { exitCode, stdout } = await host.process.run(argv, { timeoutMs: RUN_TIMEOUT_MS });
    return exitCode === 0 ? stdout.trim() : null;
  } catch {
    return null;
  }
}

async function astGrep(host: Host): Promise<{ name: string; version: string } | null> {
  for (const name of ["ast-grep", "sg"]) {
    const text = await output(host, [name, "--version"]);
    if (text?.startsWith("ast-grep ")) return { name, version: text.slice("ast-grep ".length) };
  }
  return null;
}

async function hookState(host: Host): Promise<HookState> {
  const [root, id] = await Promise.all([host.session.root(), host.session.id()]);
  const path = statusPath(root, id);
  if (path === undefined) return { kind: "unsafe-id" };
  try {
    const text = await readIfPresent(host, path);
    const status: unknown = text === null ? null : JSON.parse(text);
    const at = typeof status === "object" && status !== null && "last_hook_at" in status ? status.last_hook_at : null;
    return typeof at === "number" ? { kind: "seen", lastHookAt: at } : { kind: "missing" };
  } catch (error) {
    return { kind: "unreadable", reason: reason(error) };
  }
}

async function isStyleForced(host: Host): Promise<boolean | null> {
  try {
    const text = await host.fs.read(`${host.plugin.root}/output-styles/omca-default.md`);
    return parseFrontmatter(text)?.["force-for-plugin"] === "true";
  } catch (error) {
    host.log(`omca doctor cannot read the output style: ${reason(error)}`);
    return null;
  }
}

const MEMORY_ROOT = ".claude/agent-memory";
const AGENT_MEMORY_PREFIX = "oh-my-claudeagent-";

async function scopeHasOldMemory(host: Host, platform: Platform, dir: string): Promise<boolean> {
  if (!(await host.fs.exists(dir))) return false;
  for (const entry of await host.fs.list(dir)) {
    if (entry.kind !== "dir" || !entry.name.startsWith(AGENT_MEMORY_PREFIX)) continue;
    const memory = joinPath(platform, dir, entry.name);
    const old = entry.name.slice(AGENT_MEMORY_PREFIX.length);
    if (Object.hasOwn(RENAMES.agents, old) && (await host.fs.exists(joinPath(platform, memory, "MEMORY.md")))) return true;
    if ((await host.fs.list(memory)).some((file) => /^MEMORY\.from-.*\.md$/.test(file.name))) return true;
  }
  return false;
}

async function hasOldMemory(host: Host): Promise<boolean> {
  const [root, { platform, config }] = await Promise.all([host.session.root(), sessionOf(host)]);
  const scopes = [joinPath(platform, root, MEMORY_ROOT), ...(config === undefined ? [] : [joinPath(platform, config, "agent-memory")])];
  try {
    return (await Promise.all(scopes.map((dir) => scopeHasOldMemory(host, platform, dir)))).some(Boolean);
  } catch (error) {
    host.log(`omca doctor cannot read the agent memories: ${reason(error)}`);
    return false;
  }
}

async function check(host: Host): Promise<Doctor["checks"]> {
  const paths = await where(host);
  const [mod, engine, bun, ast, hook, now, settings, userSettings, isForced, isOld] = await Promise.all([
    pluginVersion(host),
    host.session.version(),
    output(host, ["bun", "--version"]),
    astGrep(host),
    hookState(host),
    host.clock.now(),
    host.settings.read(),
    paths.settings === undefined ? null : readIfPresent(host, paths.settings),
    isStyleForced(host),
    hasOldMemory(host),
  ]);
  const env = {
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: await host.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE(),
    CLAUDE_CODE_DISABLE_ADVISOR_TOOL: await host.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL(),
    DISABLE_TELEMETRY: await host.env.DISABLE_TELEMETRY(),
    DO_NOT_TRACK: await host.env.DO_NOT_TRACK(),
    DISABLE_GROWTHBOOK: await host.env.DISABLE_GROWTHBOOK(),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: await host.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC(),
    OMCA_GLYPHS: await host.env.OMCA_GLYPHS(),
  };
  const checks = doctorChecks({
    modVersion: mod,
    engineVersion: engine.base ?? engine.version,
    bunVersion: bun,
    astGrep: ast,
    hook,
    now,
    settings,
    options: host.options,
    env,
    userSettings,
    isStyleForced: isForced,
    hasOldMemory: isOld,
  });
  seen.clear();
  for (const { fix } of checks) {
    if (fix === "add-refresh-interval" && paths.settings !== undefined && userSettings !== null) {
      seen.set(fix, { path: paths.settings, text: userSettings });
    }
  }
  return checks;
}

const markRunning = (host: Host): Promise<void> => patch(host, { isRunning: true, error: null });

async function runChecks(host: Host): Promise<void> {
  await markRunning(host);
  host.ui.invalidate();
  try {
    const checks = await check(host);
    await patch(host, { isRunning: false, checks, ranAt: await host.clock.now() });
  } catch (error) {
    await patch(host, { isRunning: false, checks: [], error: `The checks failed: ${reason(error)}`, ranAt: await host.clock.now() });
  }
  host.ui.invalidate();
}

async function applyFix(host: Host, fix: Fix): Promise<string | null> {
  const target = seen.get(fix);
  if (target === undefined) return "Nothing to fix; press r to run the checks again";
  const { platform, home } = await where(host);
  const label = tildePath(platform, target.path, home);
  const backup = `${target.path}.omca-bak`;
  let current: string;
  try {
    current = await host.fs.read(target.path);
  } catch (error) {
    return `Could not read ${label}: ${reason(error)}`;
  }
  const after = current === target.text ? REWRITE[fix](current) : undefined;
  if (after === undefined) return `${label} changed since the check, so it was left alone; press r to check again`;
  try {
    await host.fs.write(backup, current);
  } catch (error) {
    return `Could not write the backup ${tildePath(platform, backup, home)}, so ${label} is unchanged: ${reason(error)}`;
  }
  try {
    await host.fs.write(target.path, after);
  } catch (error) {
    return `Could not write ${label}: ${reason(error)}; ${tildePath(platform, backup, home)} holds the original`;
  }
  const diff = unifiedDiff(tildePath(platform, backup, home), label, current, after);
  await patch(host, { applied: { fix, path: target.path, backupPath: backup, diff } });
  return null;
}

async function exclusive(work: () => Promise<void>): Promise<void> {
  if (isBusy) return;
  isBusy = true;
  try {
    await work();
  } finally {
    isBusy = false;
  }
}

export const run = (host: Host): Promise<void> => exclusive(() => runChecks(host));

export const fix = (host: Host, which: Fix): Promise<void> =>
  exclusive(async () => {
    const error = await applyFix(host, which);
    if (error === null) await runChecks(host);
    else {
      await patch(host, { error });
      host.ui.invalidate();
    }
  });
