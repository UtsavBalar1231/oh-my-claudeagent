import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { packageTree } from "../package.ts";
import { type Script, startServer } from "./mock-model.ts";

export const REPO = join(import.meta.dir, "..", "..");

const CLAUDE_TIMEOUT_MS = 180_000;

export type Print = (line: string) => void;

export function createChecks(print: Print = console.log) {
  const counts = { passed: 0, failed: 0 };
  const log = (text: string): void => print(`[qa] ${text}`);
  const pass = (message: string): void => {
    counts.passed++;
    log(`PASS: ${message}`);
  };
  const fail = (message: string): void => {
    counts.failed++;
    log(`FAIL: ${message}`);
  };
  return {
    counts,
    log,
    pass,
    fail,
    check: (ok: boolean, passMessage: string, failMessage: string): void => (ok ? pass(passMessage) : fail(failMessage)),
    summary(name: string): boolean {
      log(`${name}: ${counts.passed} passed, ${counts.failed} failed`);
      return counts.failed === 0;
    },
  };
}

export type Checks = ReturnType<typeof createChecks>;

export function createScratch(log: Print) {
  const created: string[] = [];
  const dir = (label: string): string => {
    const path = mkdtempSync(join(tmpdir(), `omca-qa-${label}-`));
    created.push(path);
    return path;
  };
  return {
    dir,
    project(): string {
      const path = dir("project");
      const git = (...args: string[]): void => {
        const { exitCode, stderr } = Bun.spawnSync(["git", "-C", path, ...args], { stdout: "pipe", stderr: "pipe" });
        if (exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${exitCode}: ${stderr.toString().trim()}`);
      };
      git("init", "-q");
      git("config", "user.email", "qa@example.invalid");
      git("config", "user.name", "qa harness");
      return path;
    },
    plugin(): string {
      const path = dir("package");
      packageTree(REPO, path);
      return path;
    },
    cleanup(): void {
      for (const path of created.splice(0)) {
        if (process.env.QA_KEEP_SCRATCH === "1") {
          log(`kept (QA_KEEP_SCRATCH=1): ${path}`);
          continue;
        }
        rmSync(path, { recursive: true, force: true });
        log(`removed: ${path}`);
      }
    },
  };
}

export type Scratch = ReturnType<typeof createScratch>;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function fingerprint(path: string, read: (text: string) => string): string {
  if (!existsSync(path)) return "absent";
  try {
    return sha256(read(readFileSync(path, "utf8")));
  } catch {
    return "unreadable";
  }
}

// ~/.claude.json changes on every invocation (counters, timestamps), so only the sign-in
// record is compared; the settings file is compared whole.
export function watchDrift(home: string = homedir()) {
  const files = [
    { path: join(home, ".claude", "settings.json"), read: (text: string) => text },
    {
      path: join(home, ".claude.json"),
      read: (text: string) => JSON.stringify((JSON.parse(text) as { oauthAccount?: unknown }).oauthAccount ?? null),
    },
  ];
  const before = files.map(({ path, read }) => fingerprint(path, read));
  return {
    changed: (): string[] => files.filter(({ path, read }, i) => fingerprint(path, read) !== before[i]).map(({ path }) => path),
  };
}

// A nested session must not inherit this session's id, socket, model settings or kill switches.
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(CLAUDE|ANTHROPIC|OMCA)/.test(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

export type ClaudeRun = {
  cwd: string;
  prompt: string;
  plugins?: string[];
  port: number;
  configDir: string;
  debugFile?: string;
  hookTrace?: boolean;
  permissionMode?: string;
  timeoutMs?: number;
};

export type ClaudeResult = { code: number; stdout: string; stderr: string };

export async function runClaude(run: ClaudeRun): Promise<ClaudeResult> {
  const bin = process.env.QA_CLAUDE_BIN ?? "claude";
  const argv = [
    Bun.which(bin) ?? bin,
    "-p",
    run.prompt,
    ...(run.plugins ?? []).flatMap((plugin) => ["--plugin-dir", plugin]),
    "--setting-sources",
    "project,local",
    "--permission-mode",
    run.permissionMode ?? "bypassPermissions",
    "--output-format",
    "text",
    ...(run.debugFile === undefined ? [] : ["--debug", "hooks", "--debug-file", run.debugFile]),
  ];
  const proc = Bun.spawn(argv, {
    cwd: run.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: run.timeoutMs ?? CLAUDE_TIMEOUT_MS,
    env: childEnv({
      CLAUDE_CONFIG_DIR: run.configDir,
      DISABLE_AUTOUPDATER: "1",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${run.port}`,
      ANTHROPIC_AUTH_TOKEN: "mock-token",
      ...(run.hookTrace ? { OMCA_HOOK_TRACE: "1" } : {}),
    }),
  });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, stdout, stderr };
}

export type Mock = { port: number; accessLog: string; stop: () => Promise<void> };

export function startMock(accessLog: string, script?: Script): Mock {
  const server = startServer({ port: 0, accessLogPath: accessLog, ...(script === undefined ? {} : { script }) });
  return { port: server.port ?? 0, accessLog, stop: () => server.stop(true) };
}

export type AccessEntry = {
  client: string;
  path: string;
  queue: "main" | "subagent";
  turn: number | null;
  tool_results: number;
};

export function parseJsonLines<T>(text: string): T[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

export const readJsonLines = <T>(path: string): T[] => (existsSync(path) ? parseJsonLines<T>(readFileSync(path, "utf8")) : []);

export type TraceEntry = { event: string; tool_name?: string; agent_type?: string; output: "deny" | "block" | "context" | "empty" };

export function traceCount(trace: readonly TraceEntry[], event: string, toolName?: string): number {
  return trace.filter((entry) => entry.event === event && (toolName === undefined || entry.tool_name === toolName)).length;
}

export function localhostOnly(entries: readonly AccessEntry[]): boolean {
  return entries.length > 0 && entries.every((entry) => entry.client === "127.0.0.1");
}

export type Qa = { checks: Checks; scratch: Scratch };

// Exit: 0 every check passed, 1 a check failed or a real config file changed, 2 the run could
// not be set up.
export async function runQa(name: string, body: (qa: Qa) => Promise<void>, options: { watchRealConfig: boolean }): Promise<void> {
  const checks = createChecks();
  const scratch = createScratch(checks.log);
  const drift = options.watchRealConfig ? watchDrift() : undefined;
  let setupFailed = false;
  try {
    await body({ checks, scratch });
  } catch (error) {
    setupFailed = true;
    console.error(`${name}: setup failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    scratch.cleanup();
  }
  const drifted = drift?.changed() ?? [];
  for (const path of drifted) checks.log(`ABORT-DRIFT: ${path} changed during this run`);
  const ok = checks.summary(name);
  if (setupFailed) process.exitCode = 2;
  else process.exitCode = ok && drifted.length === 0 ? 0 : 1;
}
