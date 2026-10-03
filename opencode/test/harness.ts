import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

export const repo = dirname(dirname(import.meta.dir))
export const opencodeBin = Bun.which("opencode")

type Env = Record<string, string | undefined>

export type Agent = {
  id: string
  mode?: string
  system?: string
  model?: { providerID: string; id: string } | null
  permissions?: { action: string; effect: string }[]
}
export type Listing<T> = { data?: T[] }
export type Reply<T> = { status: number; body: T | undefined; text: string }

export function scratchDir(label: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `omca-${label}-`)))
}

export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

function spawnSyncText(cmd: string[], env: Env): string {
  const result = Bun.spawnSync(cmd, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")} exited ${result.exitCode}: ${result.stderr.toString().trim()}`)
  return result.stdout.toString()
}

export function git(dir: string, ...args: string[]): string {
  const identity = ["-c", "user.name=omca", "-c", "user.email=omca@localhost", "-c", "commit.gpgsign=false"]
  return spawnSyncText(["git", ...identity, "-C", dir, ...args], { ...process.env }).trim()
}

export function commit(dir: string, message: string, ...flags: string[]): void {
  git(dir, "commit", "-q", "--allow-empty", ...flags, "-m", message)
}

export function writeConfig(dir: string, config: unknown): void {
  mkdirSync(join(dir, ".opencode"), { recursive: true })
  writeFileSync(join(dir, ".opencode", "opencode.jsonc"), `${JSON.stringify(config)}\n`)
}

// OpenCode watches the plugin's source files and reloads the plugin when one changes, so a run
// that loads the live checkout is disturbed by any edit made to it meanwhile. A private copy is
// not.
export function snapshot(dest: string): string {
  const listed = spawnSyncText(["git", "-C", repo, "ls-files", "-co", "--exclude-standard", "-z"], { ...process.env })
  for (const rel of listed.split("\0").filter(Boolean)) {
    const from = join(repo, rel)
    if (!existsSync(from)) continue
    const to = join(dest, rel)
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to, { recursive: true, verbatimSymlinks: true })
  }
  return dest
}

// A process holds its working directory open on Windows, and OpenCode starts the omca MCP server as a
// child in the project directory. Killing the parent alone leaves that child running there, so the
// scratch directory stays busy. `taskkill /T` ends the whole tree.
function endTree(proc: Bun.Subprocess): void {
  if (process.platform === "win32") Bun.spawnSync(["taskkill", "/pid", String(proc.pid), "/T", "/F"], { env: { ...process.env }, stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  else proc.kill()
}

export function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
  const port = probe.port
  void probe.stop(true)
  if (port === undefined) throw new Error("Bun.serve reported no port")
  return port
}

export async function until<T>(name: string, timeoutMs: number, probe: () => Promise<T | undefined | false>, last: () => string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() >= deadline) throw new Error(`${name}: timed out after ${timeoutMs / 1000}s, last response: ${last().slice(0, 400)}`)
    await Bun.sleep(250)
  }
}

export function countLines(text: string, needle: string): number {
  return text.split("\n").filter((line) => line.includes(needle)).length
}

export type Server = {
  base: string
  env: Env
  log(): string
  last(): string
  api<T>(method: string, path: string, dir: string, body?: unknown): Promise<Reply<T>>
  stop(): Promise<void>
}

export async function startServer(root: string, cwd: string, extraEnv: Env = {}): Promise<Server> {
  const password = crypto.randomUUID()
  // A kill switch such as OMCA_DISABLED_HOOKS in the developer's environment would turn off the
  // features under test, so only extraEnv sets OMCA variables.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OMCA_")))
  const env: Env = {
    ...inherited,
    ...extraEnv,
    PWD: cwd,
    OPENCODE_PASSWORD: password,
    OPENCODE_DB: ":memory:",
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
  }
  for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) mkdirSync(env[key] as string, { recursive: true })
  const port = freePort()
  const base = `http://127.0.0.1:${port}`
  const logPath = join(root, "server.log")
  const logFd = openSync(logPath, "a")
  const proc = Bun.spawn([opencodeBin ?? "opencode", "serve", "--port", String(port), "--hostname", "127.0.0.1", "--print-logs", "--log-level", "info"], {
    cwd,
    env,
    stdin: "ignore",
    stdout: logFd,
    stderr: logFd,
  })
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  let lastText = ""
  return {
    base,
    env,
    log: () => readFileSync(logPath, "utf8"),
    last: () => lastText,
    async api<T>(method: string, path: string, dir: string, body?: unknown): Promise<Reply<T>> {
      const query = new URLSearchParams({ "location[directory]": dir })
      try {
        const res = await fetch(`${base}${path}?${query}`, {
          method,
          headers: { authorization, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        const text = await res.text()
        lastText = text
        let parsed: T | undefined
        try {
          parsed = JSON.parse(text) as T
        } catch {
          parsed = undefined
        }
        return { status: res.status, body: parsed, text }
      } catch (err) {
        lastText = String(err)
        return { status: 0, body: undefined, text: lastText }
      }
    },
    async stop() {
      endTree(proc)
      const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(5000).then(() => false)])
      if (!exited) {
        proc.kill("SIGKILL")
        await proc.exited
      }
      closeSync(logFd)
    },
  }
}
