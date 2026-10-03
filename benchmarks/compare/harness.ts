import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { packageTree } from "../../scripts/package.ts";
import { type Script, startServer } from "../../scripts/qa/mock-model.ts";

export const HERE = import.meta.dir;
const REPO = join(HERE, "..", "..");
export const CACHE = process.env.OMCA_COMPARE_CACHE ?? join(homedir(), ".cache", "omca-compare");
export const LABEL = "omca-compare=1";
export const DRIVER_COMMAND = ["/opt/driver/bun", "/opt/driver/session.ts"];
export const DRIVER_MOUNT = `${join(HERE, "session.ts")}:/opt/driver/session.ts:ro`;
export const DUMMY_TOKEN = "mock-token";

export type TreeSpec =
  | { kind: "local-head"; marketplaceName: string }
  | { kind: "repo"; repo: string; sha: string; version: string }
  | { kind: "synthetic-single"; marketplaceName: string; pluginName: string; repo: string; sha: string; version: string; note: string };

export type Arm = {
  id: string;
  label: string;
  tree: TreeSpec | null;
  install: string[];
  details: string[];
  platform?: string;
  preseed?: string;
  imageVariant?: string;
  inEval?: false;
  limited?: { sessions: string[]; rounds: number; timeoutS: number; reason: string };
};

export type ArmsFile = { claude: string; network: { name: string; subnet: string; gateway: string }; arms: Arm[] };

export const loadArms = (): ArmsFile => JSON.parse(readFileSync(join(HERE, "arms.json"), "utf8")) as ArmsFile;

export const baseImage = (file: ArmsFile): string => `omca-compare:${file.claude}`;
export const imageFor = (file: ArmsFile, arm: Arm): string => (arm.imageVariant === undefined ? baseImage(file) : `${baseImage(file)}-${arm.imageVariant}`);

export function run(cmd: string[], options: { cwd?: string; env?: Record<string, string>; allowFail?: boolean } = {}): string {
  const r = Bun.spawnSync(cmd, {
    cwd: options.cwd ?? REPO,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...options.env },
  });
  if (r.exitCode !== 0 && !options.allowFail) {
    throw new Error(`${cmd.join(" ")} exited ${r.exitCode}: ${r.stderr.toString().trim()}`);
  }
  return r.stdout.toString();
}

export const treeDir = (armId: string): string => join(CACHE, "trees", armId);
export const templateDir = (armId: string): string => join(CACHE, "work", armId, "config");
export const installOutDir = (armId: string): string => join(CACHE, "work", armId, "install-out");

const repoCheckout = (repo: string): string => join(CACHE, "repos", basename(repo));

function ensureClone(repo: string, sha: string): string {
  const dir = repoCheckout(repo);
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(join(CACHE, "repos"), { recursive: true });
    run(["git", "clone", "--quiet", repo, dir]);
  }
  if (run(["git", "-C", dir, "cat-file", "-t", sha], { allowFail: true }).trim() !== "commit") {
    run(["git", "-C", dir, "fetch", "--quiet", "origin", sha]);
  }
  return dir;
}

function exportTree(clone: string, sha: string, dest: string): void {
  const index = join(CACHE, `index-${basename(dest)}`);
  rmSync(index, { force: true });
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const env = { GIT_INDEX_FILE: index };
  run(["git", "-C", clone, "read-tree", sha], { env });
  run(["git", "-C", clone, "checkout-index", "-a", `--prefix=${dest}/`], { env });
  rmSync(index, { force: true });
}

function writeMarketplace(dir: string, marketplace: object): void {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "marketplace.json"), `${JSON.stringify(marketplace, null, 2)}\n`);
}

export type PreparedTree = { armId: string; sha: string; dir: string };

export function prepareTree(arm: Arm): PreparedTree | null {
  const spec = arm.tree;
  if (spec === null) return null;
  const dest = treeDir(arm.id);
  if (spec.kind === "repo") {
    exportTree(ensureClone(spec.repo, spec.sha), spec.sha, dest);
    return { armId: arm.id, sha: spec.sha, dir: dest };
  }
  if (spec.kind === "synthetic-single") {
    rmSync(dest, { recursive: true, force: true });
    exportTree(ensureClone(spec.repo, spec.sha), spec.sha, join(dest, "plugin"));
    writeMarketplace(dest, {
      name: spec.marketplaceName,
      owner: { name: "omca-compare" },
      plugins: [{ name: spec.pluginName, source: "./plugin", version: spec.version, strict: true }],
    });
    return { armId: arm.id, sha: spec.sha, dir: dest };
  }
  const sha = run(["git", "rev-parse", "HEAD"]).trim();
  const staging = mkdtempSync(join(CACHE, "omca-head-"));
  try {
    exportTree(REPO, sha, staging);
    rmSync(dest, { recursive: true, force: true });
    packageTree(staging, dest);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  const manifestPath = join(dest, ".claude-plugin", "marketplace.json");
  const marketplace = JSON.parse(readFileSync(manifestPath, "utf8")) as { plugins: { source: unknown }[] };
  for (const plugin of marketplace.plugins) plugin.source = "./";
  writeFileSync(manifestPath, `${JSON.stringify(marketplace, null, 2)}\n`);
  return { armId: arm.id, sha, dir: dest };
}

export function ensureNetwork(file: ArmsFile): void {
  const { name, subnet, gateway } = file.network;
  const exists = run(["docker", "network", "ls", "--filter", `name=^${name}$`, "--format", "{{.Name}}"]).trim() === name;
  if (!exists) {
    run(["docker", "network", "create", "--internal", "--subnet", subnet, "--gateway", gateway, "--label", LABEL, name]);
  }
}

export type Recorded = {
  path: string;
  client: string;
  arrival_ms: number;
  body: Record<string, unknown>;
};

export type SessionSpec = {
  arm: Arm;
  prompt: string;
  script: Script;
  out: string;
  trace?: "execve" | "connect";
  snap?: boolean;
  debugHooks?: boolean;
  sessionId?: string;
  projectListing?: boolean;
  timeoutS?: number;
  env?: Record<string, string>;
  dockerArgs?: string[];
};

export type SessionResult = {
  recorded: Recorded[];
  paths: string[];
  clients: string[];
  meta: { start_ns: number; end_ns: number; rc: number } | null;
  out: string;
  dockerRc: number;
  stderr: string;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export type MockEndpoint = { port: number; recorded: Recorded[]; paths: string[]; clients: string[]; stop: () => Promise<void> };

export function startMockEndpoint(file: ArmsFile, script: Script, accessLogPath: string): MockEndpoint {
  rmSync(accessLogPath, { force: true });
  const mock = startServer({ port: 0, accessLogPath, script });
  const recorded: Recorded[] = [];
  const paths: string[] = [];
  const clients: string[] = [];
  const proxy = Bun.serve({
    hostname: file.network.gateway,
    port: 0,
    async fetch(req, server) {
      const url = new URL(req.url);
      const text = await req.text();
      clients.push(server.requestIP(req)?.address ?? "");
      paths.push(`${req.method} ${url.pathname}`);
      let body: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(text);
        if (isRecord(parsed)) body = parsed;
      } catch {}
      if (req.method === "POST" && url.pathname.startsWith("/v1/messages")) {
        recorded.push({ path: url.pathname, client: clients.at(-1) ?? "", arrival_ms: Date.now(), body });
      }
      const headers = new Headers(req.headers);
      headers.delete("host");
      headers.delete("content-length");
      headers.set("accept-encoding", "identity");
      const upstream = await fetch(`http://127.0.0.1:${mock.port}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        ...(req.method === "POST" ? { body: text } : {}),
      });
      return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    },
  });
  if (proxy.port === undefined) throw new Error("the recording proxy has no TCP port");
  return {
    port: proxy.port,
    recorded,
    paths,
    clients,
    stop: async () => {
      await proxy.stop(true);
      await mock.stop();
    },
  };
}

export async function runSession(file: ArmsFile, spec: SessionSpec): Promise<SessionResult> {
  rmSync(spec.out, { recursive: true, force: true });
  mkdirSync(spec.out, { recursive: true });
  const endpoint = startMockEndpoint(file, spec.script, `${spec.out}.access.jsonl`);
  const docker = ["docker", "run", "--rm", "--label", LABEL, "--network", file.network.name];
  docker.push("--add-host", `host.docker.internal:${file.network.gateway}`);
  if (spec.trace !== undefined) docker.push("--cap-add=SYS_PTRACE");
  const env: Record<string, string> = {
    MODE: "session",
    PROMPT: spec.prompt,
    ANTHROPIC_BASE_URL: `http://host.docker.internal:${endpoint.port}`,
    ANTHROPIC_AUTH_TOKEN: DUMMY_TOKEN,
    ...(spec.trace === undefined ? {} : { TRACE: spec.trace }),
    ...(spec.snap ? { SNAP: "1" } : {}),
    ...(spec.debugHooks ? { DEBUG_HOOKS: "1" } : {}),
    ...(spec.sessionId === undefined ? {} : { SESSION_ID: spec.sessionId }),
    ...(spec.projectListing ? { PROJECT_LISTING: "1" } : {}),
    ...(spec.timeoutS === undefined ? {} : { TIMEOUT_S: String(spec.timeoutS) }),
    ...spec.env,
  };
  for (const [key, value] of Object.entries(env)) docker.push("-e", `${key}=${value}`);
  docker.push("-v", `${spec.out}:/out`, "-v", `${join(HERE, "fixtures")}:/fixtures:ro`, "-v", DRIVER_MOUNT);
  if (spec.arm.tree !== null) {
    docker.push("-v", `${templateDir(spec.arm.id)}:/template:ro`, "-v", `${treeDir(spec.arm.id)}:/market/${spec.arm.id}:ro`);
  }
  docker.push(...(spec.dockerArgs ?? []), imageFor(file, spec.arm), ...DRIVER_COMMAND);
  const proc = Bun.spawn(docker, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [dockerRc, , stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await endpoint.stop();
  const metaText = readText(join(spec.out, "meta.json"));
  return {
    recorded: endpoint.recorded,
    paths: endpoint.paths,
    clients: endpoint.clients,
    meta: metaText === "" ? null : (JSON.parse(metaText) as SessionResult["meta"]),
    out: spec.out,
    dockerRc,
    stderr,
  };
}

export type InstallResult = { steps: { step: number; cmd: string; rc: number; ms: number }[]; out: string; dockerRc: number; stderr: string };

export async function runInstall(file: ArmsFile, arm: Arm, options: { snap: boolean; traceConnect: boolean; online?: boolean }): Promise<InstallResult> {
  const out = options.online ? `${installOutDir(arm.id)}-online` : installOutDir(arm.id);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const docker = ["docker", "run", "--rm", "--label", LABEL, "--network", options.online ? "bridge" : file.network.name];
  if (options.traceConnect) docker.push("--cap-add=SYS_PTRACE");
  const env: Record<string, string> = {
    MODE: "install",
    MARKETS: `/market/${arm.id}`,
    INSTALL_IDS: arm.install.join(" "),
    DETAIL_NAMES: arm.details.join(" "),
    ...(options.snap ? { SNAP: "1" } : {}),
    ...(options.traceConnect ? { TRACE_CONNECT: "1" } : {}),
  };
  for (const [key, value] of Object.entries(env)) docker.push("-e", `${key}=${value}`);
  docker.push("-v", `${out}:/out`, "-v", `${treeDir(arm.id)}:/market/${arm.id}:ro`, "-v", DRIVER_MOUNT, imageFor(file, arm), ...DRIVER_COMMAND);
  const proc = Bun.spawn(docker, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [dockerRc, , stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const stepsText = readText(join(out, "install", "steps.jsonl"));
  const steps = stepsText
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as InstallResult["steps"][number]);
  if (!options.online) {
    rmSync(templateDir(arm.id), { recursive: true, force: true });
    mkdirSync(join(CACHE, "work", arm.id), { recursive: true });
    if (existsSync(join(out, "config"))) run(["mv", join(out, "config"), templateDir(arm.id)]);
  }
  return { steps, out, dockerRc, stderr };
}

export function leftoverContainers(): string[] {
  return run(["docker", "ps", "-a", "--filter", `label=${LABEL}`, "--format", "{{.ID}} {{.Status}}"])
    .split("\n")
    .filter(Boolean);
}
