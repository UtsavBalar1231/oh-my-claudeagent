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

const HELD = new Set(["EBUSY", "EPERM", "ENOTEMPTY"])
const REMOVE_ATTEMPTS = 20
const REMOVE_WAIT_MS = 250

// Windows frees a killed process's handles shortly after it exits, and bun's rmSync does not
// retry, so the folder a stopped server used can still read as busy.
export async function removeDir(path: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : ""
      if (attempt === REMOVE_ATTEMPTS || !HELD.has(code)) throw error
      await Bun.sleep(REMOVE_WAIT_MS)
    }
  }
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

export function packageFixture(dest: string): { directory: string; spec: string; stop(): Promise<void> } {
  const directory = snapshot(dest)
  git(directory, "init", "-q")
  git(directory, "add", "-A")
  commit(directory, "package")
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (!["/info/refs", "/git-upload-pack", "/HEAD"].includes(url.pathname)) return new Response(null, { status: 404 })
      const body = new Uint8Array(await request.arrayBuffer())
      const child = Bun.spawn(["git", "http-backend"], {
        env: { ...process.env, GIT_PROJECT_ROOT: directory, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: `/.git${url.pathname}`, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method, CONTENT_TYPE: request.headers.get("content-type") ?? "", CONTENT_LENGTH: String(body.length) },
        stdin: body, stdout: "pipe", stderr: "pipe",
      })
      const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text()])
      if (code !== 0) return new Response(error, { status: 500 })
      const bytes = Buffer.from(output)
      const end = bytes.indexOf("\r\n\r\n")
      if (end < 0) return new Response("Missing Git CGI headers", { status: 500 })
      const headers = new Headers()
      let status = 200
      for (const line of bytes.subarray(0, end).toString().split("\r\n")) {
        const colon = line.indexOf(":")
        const name = line.slice(0, colon)
        const value = line.slice(colon + 1).trim()
        if (name.toLowerCase() === "status") status = Number.parseInt(value, 10)
        else headers.set(name, value)
      }
      return new Response(bytes.subarray(end + 4), { status, headers })
    },
  })
  const { name } = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { name: string }
  return { directory, spec: `${name}@git+http://127.0.0.1:${server.port}`, stop: async () => { await server.stop(true) } }
}

export async function startStubProvider(root: string): Promise<{ port: string; requests: string; stop(): Promise<void> }> {
  const requests = join(root, "requests.jsonl")
  const output = join(root, "stub.out")
  writeFileSync(requests, "")
  const fd = openSync(output, "a")
  const proc = Bun.spawn([process.execPath, join(repo, "opencode", "test", "stub-provider.ts")], {
    env: { ...process.env, STUB_LOG: requests }, stdin: "ignore", stdout: fd, stderr: fd,
  })
  const stop = async () => {
    proc.kill()
    await proc.exited
    closeSync(fd)
  }
  try {
    const port = await until("stub started", 5_000, async () => readFileSync(output, "utf8").match(/^listening (\d+)/m)?.[1], () => readFileSync(output, "utf8"))
    return { port, requests, stop }
  } catch (error) {
    await stop()
    throw error
  }
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

export function isolatedEnv(root: string, cwd: string, extraEnv: Env = {}): Env {
  // A kill switch such as OMCA_DISABLED_HOOKS in the developer's environment would turn off the
  // features under test, so only extraEnv sets OMCA variables.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OMCA_")))
  const env: Env = {
    ...inherited,
    ...extraEnv,
    PWD: cwd,
    OPENCODE_DB: ":memory:",
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
  }
  for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) mkdirSync(env[key] as string, { recursive: true })
  return env
}

export async function installPackage(spec: string, env: Env, cwd: string): Promise<void> {
  const child = Bun.spawn([opencodeBin ?? "opencode", "plugin", "add", spec], { cwd, env, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => endTree(child), 150_000)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (code !== 0) throw new Error(`Package installation exited ${code}:\n${stdout}\n${stderr}`)
  } finally {
    clearTimeout(timer)
  }
}

export async function startServer(root: string, cwd: string, extraEnv: Env = {}): Promise<Server> {
  const password = crypto.randomUUID()
  const env = isolatedEnv(root, cwd, { ...extraEnv, OPENCODE_PASSWORD: password })
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
