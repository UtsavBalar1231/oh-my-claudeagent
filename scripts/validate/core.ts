import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../src/core/tool-input.ts";

export type Status = "pass" | "fail" | "skip" | "warn";
export type Outcome = { status: Status; detail: string };

export type Context = {
  root: string;
  agentsDir: string;
  skillsDir: string;
  marketplacePath: string;
  marketplaceOverride: boolean;
  tracked: () => readonly string[];
};

export type Check = { name: string; run: (ctx: Context) => Outcome | Promise<Outcome> };

export const pass = (detail: string): Outcome => ({ status: "pass", detail });
export const skip = (detail: string): Outcome => ({ status: "skip", detail });

export function verdict(problems: readonly string[], passed: string): Outcome {
  return problems.length === 0 ? pass(passed) : { status: "fail", detail: problems.join("; ") };
}

export const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

export const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

/** What a finished child process left: its exit code and its output. */
export type Run = { code: number; stdout: string; stderr: string };

/** The caller's environment without the variables whose names match `drop`, with `extra` applied last. */
export function envWithout(drop: RegExp, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !drop.test(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

export function run(argv: readonly string[], cwd: string, options: { input?: string; timeoutMs?: number } = {}): Run {
  try {
    const proc = Bun.spawnSync([...argv], {
      cwd,
      env: envWithout(/^GIT_/),
      stdin: options.input === undefined ? "ignore" : Buffer.from(options.input),
      stdout: "pipe",
      stderr: "pipe",
      timeout: options.timeoutMs ?? 120_000,
    });
    return { code: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  } catch (error) {
    return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

export function gitTracked(root: string): string[] {
  const listing = run(["git", "ls-files", "-z"], root);
  if (listing.code !== 0) throw new Error(`git ls-files failed: ${listing.stderr.trim()}`);
  return listing.stdout
    .split("\0")
    .filter((path) => path !== "" && statSync(join(root, path), { throwIfNoEntry: false })?.isFile() === true);
}

export function createContext(root: string, overrides: Partial<Context> = {}): Context {
  let listing: readonly string[] | undefined;
  return {
    root,
    agentsDir: join(root, "agents"),
    skillsDir: join(root, "skills"),
    marketplacePath: join(root, ".claude-plugin", "marketplace.json"),
    marketplaceOverride: false,
    tracked: () => (listing ??= gitTracked(root)),
    ...overrides,
  };
}

export function readText(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

export function listFiles(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .sort()
    .map((name) => join(dir, name));
}

export function relative(root: string, path: string): string {
  return path.startsWith(root) ? path.slice(root.length).replace(/^[\\/]+/, "").replaceAll("\\", "/") : path;
}
