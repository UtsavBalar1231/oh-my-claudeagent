import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeExec } from "../tests/fixtures/fake-exec.ts";
import { specEnv } from "../tests/fixtures/spec-env.ts";
import { createDispatcher, type Handler } from "./jsonrpc.ts";
import { createProgress } from "./progress.ts";

const SERVER = join(import.meta.dir, "omca.ts");
const CLIENT_TEXT_CAP_CHARS = 2048;
const MAX_RESULT_SIZE_CEILING = 500_000;
const MAX_RESULT_SIZE_TOOLS = ["evidence_read", "file_read", "ast_search", "session_search"];
const WRITE_TOOLS = ["ast_replace", "boulder_write", "evidence_log", "notepad_compact", "notepad_write", "omca_hook"];
const MODERN = "2026-07-28";
const FALLBACK = "2025-11-25";
const VERSION_META = "io.modelcontextprotocol/protocolVersion";
const modernMeta = { [VERSION_META]: MODERN, "io.modelcontextprotocol/clientInfo": { name: "spec", version: "0" }, "io.modelcontextprotocol/clientCapabilities": {} };
const EXPECTED_TOOLS: string[] = JSON.parse(readFileSync(join(import.meta.dir, "..", "tests", "fixtures", "mcp", "expected-tools.json"), "utf8"));
const PROPERTY_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

const VERSION: string = JSON.parse(readFileSync(join(import.meta.dir, "..", ".claude-plugin", "plugin.json"), "utf8")).version;

const OMCA_HOOK = {
  name: "omca_hook",
  description: "Internal: OMCA's settings hooks call this. Not for direct use.",
  inputSchema: {
    type: "object",
    properties: { event: { type: "string" } },
    required: ["event"],
    additionalProperties: { type: "string" },
  },
  annotations: { title: "OMCA hook entry point", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

type Message = Record<string, unknown>;
type Reply = { jsonrpc: string; id?: number | null; result?: unknown; error?: unknown; method?: string; params?: Message };
type ToolDeclaration = {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown> };
  annotations: { title?: string; readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  outputSchema?: unknown;
  _meta?: Record<string, unknown>;
};

type Server = {
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  project: string;
  send: (...messages: Array<Message | string>) => void;
  next: () => Promise<Reply>;
  request: (method: string, params?: Message) => Promise<Reply>;
};

const running: Server[] = [];
const scratch: string[] = [];

// A killed process keeps its working directory open on Windows until it has exited, so the directory is removed only after the exit.
afterEach(async () => {
  for (const server of running.splice(0)) {
    server.proc.kill("SIGKILL");
    await server.proc.exited;
    rmSync(server.project, { recursive: true, force: true });
  }
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "omca-server-scratch-")));
  scratch.push(dir);
  return dir;
}

function startServer(env: Record<string, string | undefined> = {}): Server {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "omca-server-")));
  expect(Bun.spawnSync(["git", "init", "-q", project], { env: specEnv() }).exitCode).toBe(0);
  const proc = Bun.spawn([process.execPath, SERVER], { cwd: project, env: specEnv(env), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let nextId = 1;

  const send = (...messages: Array<Message | string>) => {
    proc.stdin.write(messages.map((m) => `${typeof m === "string" ? m : JSON.stringify(m)}\n`).join(""));
    proc.stdin.flush();
  };
  const next = async (): Promise<Reply> => {
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        return JSON.parse(line);
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("the server closed stdout");
      buffer += decoder.decode(value, { stream: true });
    }
  };
  const request = async (method: string, params?: Message) => {
    const id = nextId++;
    send({ jsonrpc: "2.0", id, method, ...(params && { params }) });
    const reply = await next();
    expect(reply.id).toBe(id);
    return reply;
  };
  const server = { proc, project, send, next, request };
  running.push(server);
  return server;
}

const listTools = async (server: Server): Promise<ToolDeclaration[]> =>
  ((await server.request("tools/list")).result as { tools: ToolDeclaration[] }).tools;

describe("handshake", () => {
  test("server/discover offers 2026-07-28 with the capabilities, instructions and server info", async () => {
    const server = startServer();
    const reply = await server.request("server/discover", {
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
    });
    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        supportedVersions: ["2026-07-28", "2025-11-25"],
        capabilities: { tools: { listChanged: false } },
        instructions: expect.any(String),
        ttlMs: 0,
        cacheScope: "private",
        resultType: "complete",
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "omca", version: VERSION } },
      },
    });
  });

  test("initialize with 2025-11-25 echoes the version, and the initialized notification gets no reply", async () => {
    const server = startServer();
    const reply = await server.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "spec", version: "0" },
    });
    expect(reply.result).toEqual({
      protocolVersion: "2025-11-25",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "omca", version: VERSION },
      instructions: expect.any(String),
    });
    server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect((await server.request("ping")).result).toEqual({});
  });

  test.each([
    [MODERN, MODERN],
    [FALLBACK, FALLBACK],
    ["2099-01-01", MODERN],
    ["2024-11-05", MODERN],
    ["", MODERN],
  ])("initialize naming %p is answered with %p", async (requested, answered) => {
    const reply = await startServer().request("initialize", { protocolVersion: requested, capabilities: {}, clientInfo: { name: "spec", version: "0" } });
    expect((reply.result as { protocolVersion: string }).protocolVersion).toBe(answered);
  });

  test("initialize without a protocol version is an invalid-params error", async () => {
    const server = startServer();
    expect((await server.request("initialize", {})).error).toEqual({
      code: -32602,
      message: "initialize: protocolVersion must be a string",
    });
  });

  test("start-up creates .omca/state and .omca/.gitignore under the project root", async () => {
    const server = startServer();
    await server.request("ping");
    expect(statSync(join(server.project, ".omca", "state")).isDirectory()).toBe(true);
    expect(readFileSync(join(server.project, ".omca", ".gitignore"), "utf8")).toBe("*\n!/rules/\n");
  });
});

describe("JSON-RPC framing", () => {
  test("malformed JSON gets a parse error and the server keeps answering", async () => {
    const server = startServer();
    server.send("{not json");
    expect(await server.next()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    expect((await server.request("ping")).result).toEqual({});
  });

  test("an unknown method gets method-not-found", async () => {
    const server = startServer();
    expect((await server.request("resources/list")).error).toEqual({
      code: -32601,
      message: "Method not found: resources/list",
    });
  });

  test("a message that is not a request gets invalid-request", async () => {
    const server = startServer();
    server.send({ jsonrpc: "2.0", id: 4 }, { jsonrpc: "1.0", id: 5, method: "ping" }, { jsonrpc: "2.0", id: {}, method: "ping" });
    const replies = [await server.next(), await server.next(), await server.next()];
    const invalid = { code: -32600, message: "Invalid Request" };
    expect(replies).toEqual([
      { jsonrpc: "2.0", id: 4, error: invalid },
      { jsonrpc: "2.0", id: 5, error: invalid },
      { jsonrpc: "2.0", id: null, error: invalid },
    ]);
  });

  test("non-object params get invalid-params", async () => {
    const server = startServer();
    server.send({ jsonrpc: "2.0", id: 9, method: "tools/list", params: [] });
    expect(await server.next()).toEqual({
      jsonrpc: "2.0",
      id: 9,
      error: { code: -32602, message: "tools/list: params must be an object" },
    });
  });

  test("two in-flight tools/call requests both answer, matched by id", async () => {
    const server = startServer();
    const call = (id: number, event: string) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "omca_hook", arguments: { event } },
    });
    server.send(call(11, "Stop"), call(12, "PreToolUse"));
    const replies = [await server.next(), await server.next()].sort((a, b) => Number(a.id) - Number(b.id));
    const result = { content: [{ type: "text", text: "{}" }], resultType: "complete" };
    expect(replies).toEqual([
      { jsonrpc: "2.0", id: 11, result },
      { jsonrpc: "2.0", id: 12, result },
    ]);
  });

  test("a slow request does not hold up a later one", async () => {
    const lines: string[] = [];
    let finishSlow = () => {};
    const handlers: Record<string, Handler> = {
      slow: () => new Promise((resolve) => (finishSlow = () => resolve("slow"))),
      fast: () => "fast",
    };
    const feed = createDispatcher(handlers, (line) => lines.push(line));
    feed('{"jsonrpc":"2.0","id":1,"method":"slow"}\n{"jsonrpc":"2.0","id":2,"method":"fast"}\n');
    await Bun.sleep(0);
    expect(lines).toEqual(['{"jsonrpc":"2.0","id":2,"result":"fast"}\n']);
    finishSlow();
    await Bun.sleep(0);
    expect(lines[1]).toBe('{"jsonrpc":"2.0","id":1,"result":"slow"}\n');
  });

  test("a request split across chunks is answered once it is complete", async () => {
    const lines: string[] = [];
    const feed = createDispatcher({ ping: () => ({}) }, (line) => lines.push(line));
    feed('{"jsonrpc":"2.0",');
    feed('"id":1,"method":"ping"}\r\n');
    await Bun.sleep(0);
    expect(lines).toEqual(['{"jsonrpc":"2.0","id":1,"result":{}}\n']);
  });
});

describe("tools", () => {
  test("tools/list is the model's tools from the fixture plus omca_hook", async () => {
    const names = (await listTools(startServer())).map((tool) => tool.name);
    expect(names.toSorted()).toEqual([...EXPECTED_TOOLS, "omca_hook"].toSorted());
  });

  test("tools/list tells the client not to cache the list and marks the result complete", async () => {
    expect((await startServer().request("tools/list")).result).toMatchObject({
      ttlMs: 0,
      cacheScope: "private",
      resultType: "complete",
    });
  });

  test("omca_hook is declared exactly", async () => {
    expect((await listTools(startServer())).find((tool) => tool.name === "omca_hook")).toEqual(OMCA_HOOK);
  });

  test("omca_hook answers an empty hook result", async () => {
    const server = startServer();
    expect((await server.request("tools/call", { name: "omca_hook", arguments: { event: "Stop" } })).result).toEqual({
      content: [{ type: "text", text: "{}" }],
      resultType: "complete",
    });
  });

  test("omca_hook without an event is a tool error, not a protocol error", async () => {
    const server = startServer();
    expect((await server.request("tools/call", { name: "omca_hook", arguments: {} })).result).toEqual({
      content: [{ type: "text", text: "omca_hook: event must be a string" }],
      isError: true,
      resultType: "complete",
    });
  });

  test("an unknown tool is an invalid-params protocol error", async () => {
    const server = startServer();
    expect((await server.request("tools/call", { name: "no_such_tool", arguments: {} })).error).toEqual({
      code: -32602,
      message: "Unknown tool: no_such_tool",
    });
  });

  test("tools/list names every tool in one fixed, name-sorted order", async () => {
    const names = (await listTools(startServer())).map((tool) => tool.name);
    expect(names).toEqual(names.toSorted());
    expect(new Set(names).size).toBe(names.length);
  });
});

const INVALID_INPUT: Record<string, Message> = {
  ast_search: {},
  ast_replace: {},
  ast_find_rule: {},
  ast_dump_tree: {},
  ast_test_rule: {},
  boulder_write: {},
  boulder_progress: { plan_path: 1 },
  evidence_log: {},
  evidence_read: { working_directory: 1 },
  notepad_write: {},
  notepad_read: {},
  notepad_list: { plan_name: 1 },
  notepad_compact: {},
  health_check: { working_directory: 1 },
  file_read: {},
  session_search: {},
  omca_hook: {},
};
const TAKES_NO_INPUT = ["agents_list", "categories_list"];

describe("input validation", () => {
  test("every tool with inputs answers a bad call as an isError tool result, not a protocol error", async () => {
    const server = startServer();
    const names = (await listTools(server)).map((tool) => tool.name);
    expect(names.toSorted()).toEqual([...Object.keys(INVALID_INPUT), ...TAKES_NO_INPUT].toSorted());
    for (const [name, args] of Object.entries(INVALID_INPUT)) {
      const reply = await server.request("tools/call", { name, arguments: args });
      expect({ name, error: reply.error }).toEqual({ name, error: undefined });
      expect({ name, result: reply.result }).toEqual({
        name,
        result: { content: [{ type: "text", text: expect.stringMatching(/\S/) }], isError: true, resultType: "complete" },
      });
    }
  });

  test("non-object arguments are an isError tool result naming the tool", async () => {
    const server = startServer();
    expect((await server.request("tools/call", { name: "omca_hook", arguments: "x" })).result).toEqual({
      content: [{ type: "text", text: "omca_hook: arguments must be an object" }],
      isError: true,
      resultType: "complete",
    });
  });

  test("a tool that takes no inputs ignores stray arguments", async () => {
    const server = startServer();
    for (const name of TAKES_NO_INPUT) {
      const reply = await server.request("tools/call", { name, arguments: { stray: 1 } });
      expect(reply.result).toMatchObject({ resultType: "complete" });
      expect(reply.result).not.toHaveProperty("isError");
    }
  });
});

describe("protocol revisions", () => {
  const toolCall = { name: "omca_hook", arguments: { event: "Stop" } };
  const completed = { content: [{ type: "text", text: "{}" }], resultType: "complete" };

  test("the default stdio path: initialize 2025-11-25, initialized, then tools/list and tools/call", async () => {
    const server = startServer();
    const init = await server.request("initialize", { protocolVersion: FALLBACK, capabilities: {}, clientInfo: { name: "spec", version: "0" } });
    expect(init.result).toMatchObject({ protocolVersion: FALLBACK, serverInfo: { name: "omca", version: VERSION } });
    server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const names = (await listTools(server)).map((tool) => tool.name);
    expect(names).toContain("omca_hook");
    expect((await server.request("tools/call", toolCall)).result).toEqual(completed);
  });

  test("the discover path: server/discover, then 2026-07-28 requests that each carry the version in _meta", async () => {
    const server = startServer();
    const discovered = await server.request("server/discover", { _meta: modernMeta });
    expect(discovered.result).toMatchObject({
      supportedVersions: [MODERN, FALLBACK],
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "omca", version: VERSION } },
    });
    const listed = await server.request("tools/list", { _meta: modernMeta });
    expect(listed.result).toMatchObject({ ttlMs: 0, cacheScope: "private", resultType: "complete" });
    expect((await server.request("tools/call", { ...toolCall, _meta: modernMeta })).result).toEqual(completed);
  });

  test("both paths list the same tools in the same order", async () => {
    const legacy = startServer();
    await legacy.request("initialize", { protocolVersion: FALLBACK });
    const modern = startServer();
    const order = async (server: Server, params?: Message) =>
      ((await server.request("tools/list", params)).result as { tools: ToolDeclaration[] }).tools.map((tool) => tool.name);
    expect(await order(modern, { _meta: modernMeta })).toEqual(await order(legacy));
  });

  test("a request naming a version the server does not speak gets -32022 with the supported and requested versions", async () => {
    const server = startServer();
    const unsupported = { [VERSION_META]: "2099-01-01" };
    for (const [method, params] of [
      ["server/discover", { _meta: unsupported }],
      ["tools/list", { _meta: unsupported }],
      ["tools/call", { ...toolCall, _meta: unsupported }],
    ] as const) {
      expect((await server.request(method, params)).error).toEqual({
        code: -32022,
        message: "Unsupported protocol version: 2099-01-01",
        data: { supported: [MODERN, FALLBACK], requested: "2099-01-01" },
      });
    }
    expect((await server.request("ping")).result).toEqual({});
  });

  test("a notification naming an unsupported version gets no reply", async () => {
    const server = startServer();
    server.send({ jsonrpc: "2.0", method: "notifications/initialized", params: { _meta: { [VERSION_META]: "2099-01-01" } } });
    expect((await server.request("ping")).result).toEqual({});
  });
});

describe("tool annotations", () => {
  type Expected = { title: string; readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  const reader = (title: string): Expected => ({ title, readOnlyHint: true, idempotentHint: true });
  const EXPECTED_ANNOTATIONS: Record<string, Expected> = {
    agents_list: reader("List agents"),
    ast_dump_tree: reader("Dump a snippet's syntax tree"),
    ast_find_rule: reader("Search code by YAML rule"),
    ast_replace: { title: "Rewrite code by AST pattern", readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    ast_search: reader("Search code by AST pattern"),
    ast_test_rule: reader("Test a YAML rule on a snippet"),
    boulder_progress: reader("Check plan progress"),
    boulder_write: { title: "Register work plan", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    categories_list: reader("List model categories"),
    evidence_log: { title: "Log verification evidence", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    evidence_read: reader("Read verification evidence"),
    file_read: reader("Read a file"),
    health_check: reader("Check OMCA health"),
    notepad_compact: { title: "Compact notepad section", readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    notepad_list: reader("List notepads"),
    notepad_read: reader("Read notepad"),
    notepad_write: { title: "Append to notepad", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    omca_hook: { title: "OMCA hook entry point", readOnlyHint: false, destructiveHint: false },
    session_search: reader("Search session transcripts"),
  };

  test("every tool declares its title and hints exactly, with openWorldHint false", async () => {
    const tools = await listTools(startServer());
    expect(tools.map((tool) => tool.name).toSorted()).toEqual(Object.keys(EXPECTED_ANNOTATIONS).toSorted());
    for (const tool of tools) {
      expect({ name: tool.name, annotations: tool.annotations }).toEqual({
        name: tool.name,
        annotations: { ...EXPECTED_ANNOTATIONS[tool.name], openWorldHint: false },
      });
    }
  });
});

describe("tool declaration contract", () => {
  test("every listed tool meets the client's declaration contract", async () => {
    const tools = await listTools(startServer());
    const violations: string[] = [];
    for (const tool of tools) {
      const flag = (problem: string) => violations.push(`${tool.name}: ${problem}`);
      if (tool.outputSchema !== undefined) flag("declares an outputSchema");
      if (!tool.description || tool.description.length > CLIENT_TEXT_CAP_CHARS) flag("description is empty or over the cap");
      if (tool.inputSchema.type !== "object") flag("inputSchema is not an object schema");
      for (const property of Object.keys(tool.inputSchema.properties)) {
        if (!PROPERTY_NAME.test(property)) flag(`input property "${property}" breaks the name rule`);
      }
      if (typeof tool.annotations.readOnlyHint !== "boolean") flag("readOnlyHint is unset");
      if (tool.annotations.openWorldHint !== false) flag("openWorldHint is not false");
      if (tool.annotations.readOnlyHint && tool.annotations.destructiveHint !== undefined) flag("read-only but states destructiveHint");
      if (!tool.annotations.readOnlyHint && typeof tool.annotations.destructiveHint !== "boolean") flag("writes but leaves destructiveHint unset");
      const maxResult = tool._meta?.["anthropic/maxResultSizeChars"];
      if (maxResult !== undefined && !MAX_RESULT_SIZE_TOOLS.includes(tool.name)) flag("declares maxResultSizeChars");
      if (maxResult !== undefined && !(Number.isInteger(maxResult) && Number(maxResult) > 0 && Number(maxResult) <= MAX_RESULT_SIZE_CEILING)) {
        flag("maxResultSizeChars is not an integer within the client ceiling");
      }
    }
    expect(violations).toEqual([]);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
    expect(tools.filter((tool) => !tool.annotations.readOnlyHint).map((tool) => tool.name)).toEqual(WRITE_TOOLS);
  });

  test("the server instructions fit the client cap and name every tool the model is meant to call", async () => {
    const result = (await startServer().request("initialize", { protocolVersion: "2025-11-25" })).result as { instructions: string };
    expect(result.instructions.length).toBeLessThanOrEqual(CLIENT_TEXT_CAP_CHARS);
    expect(EXPECTED_TOOLS.filter((name) => !result.instructions.includes(`\`${name}\``))).toEqual([]);
  });
});

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(isDone: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!isDone()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

const astSearch = (id: number, meta?: Message): Message => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "ast_search", arguments: { pattern: "x", lang: "python" }, ...(meta && { _meta: meta }) },
});

async function untilReply(server: Server, id: number): Promise<{ notifications: Reply[]; reply: Reply }> {
  const notifications: Reply[] = [];
  for (;;) {
    const message = await server.next();
    if (message.id === id) return { notifications, reply: message };
    notifications.push(message);
  }
}

describe("cancellation", () => {
  test("notifications/cancelled aborts the in-flight call, kills its ast-grep child and writes no result", async () => {
    const dir = scratchDir();
    const pidFile = join(dir, "pid");
    const fake = fakeExec(dir, "ast-grep", [`import { writeFileSync } from "node:fs";`, `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`, "await Bun.sleep(20000);"].join("\n"));
    const server = startServer({ AST_GREP_BIN: fake });
    await server.request("ping");
    server.send(astSearch(7, { progressToken: "gone" }));
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "", "the fake ast-grep to start");
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(isAlive(pid)).toBe(true);
    expect(await server.next()).toMatchObject({ method: "notifications/progress", params: { progressToken: "gone" } });

    server.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7, reason: "spec" } });
    await until(() => !isAlive(pid), "the fake ast-grep to be gone");

    for (let ping = 0; ping < 3; ping++) expect((await server.request("ping")).result).toEqual({});
    expect(server.proc.exitCode).toBeNull();
  });

  test("a cancellation for a request that is not in flight is ignored", async () => {
    const server = startServer();
    server.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 99 } });
    server.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: "bogus" });
    expect((await server.request("ping")).result).toEqual({});
  });

  test("the dispatcher aborts the signal of the named request only and sends no reply for it", async () => {
    const lines: string[] = [];
    const signals = new Map<number, AbortSignal>();
    const handlers: Record<string, Handler> = {
      slow: (params, { signal }) => {
        signals.set(Number(params.n), signal);
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      },
    };
    const feed = createDispatcher(handlers, (line) => lines.push(line));
    feed('{"jsonrpc":"2.0","id":1,"method":"slow","params":{"n":1}}\n{"jsonrpc":"2.0","id":"b","method":"slow","params":{"n":2}}\n');
    feed('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}\n');
    await Bun.sleep(0);
    expect([signals.get(1)?.aborted, signals.get(2)?.aborted]).toEqual([true, false]);
    expect(lines).toEqual([]);
    feed('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"b"}}\n');
    await Bun.sleep(0);
    expect(lines).toEqual([]);
  });
});

describe("progress", () => {
  const SLOW_MS = 1_500;

  function slowAstGrep(): string {
    return fakeExec(scratchDir(), "ast-grep", `await Bun.sleep(${SLOW_MS});\nconsole.log("[]");`);
  }

  test("a call with a progress token gets throttled notifications/progress before its result", async () => {
    const server = startServer({ AST_GREP_BIN: slowAstGrep() });
    server.send(astSearch(3, { progressToken: "tok-1" }));
    const { notifications, reply } = await untilReply(server, 3);
    expect(reply.result).toMatchObject({ resultType: "complete" });
    expect(notifications.length).toBeGreaterThanOrEqual(2);
    expect(notifications.length).toBeLessThanOrEqual(3);
    for (const notification of notifications) {
      expect(notification).toMatchObject({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "tok-1", message: expect.stringMatching(/^ast-grep running/) } });
      expect(notification).not.toHaveProperty("id");
    }
    const values = notifications.map((notification) => Number(notification.params?.progress));
    expect(values).toEqual(values.toSorted((a, b) => a - b));
    expect(new Set(values).size).toBe(values.length);
  });

  test("a call without a progress token gets none", async () => {
    const server = startServer({ AST_GREP_BIN: slowAstGrep() });
    server.send(astSearch(4));
    const first = await untilReply(server, 4);
    server.send(astSearch(5, {}));
    const second = await untilReply(server, 5);
    expect([first.notifications, second.notifications]).toEqual([[], []]);
  });

  test("session_search reports how many transcripts it has searched, with a numeric token, inside the throttle", async () => {
    const transcripts = scratchDir();
    const project = realpathSync(mkdtempSync(join(tmpdir(), "omca-server-")));
    scratch.push(project);
    expect(Bun.spawnSync(["git", "init", "-q", project], { env: specEnv() }).exitCode).toBe(0);
    const dir = join(transcripts, "projects", project.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(dir, { recursive: true });
    const FILES = 30;
    for (let i = 0; i < FILES; i++) writeFileSync(join(dir, `s${i}.jsonl`), `${JSON.stringify({ type: "user", message: { content: "hello" } })}\n`);
    const server = startServer({ OMCA_TRANSCRIPTS_ROOT: join(transcripts, "projects") });
    server.send({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "session_search", arguments: { query: "absent", project_path: project }, _meta: { progressToken: 42 } },
    });
    const { notifications, reply } = await untilReply(server, 6);
    expect(reply.result).toMatchObject({ resultType: "complete" });
    expect(notifications.length).toBeGreaterThanOrEqual(1);
    expect(notifications.length).toBeLessThan(FILES);
    expect(notifications[0]).toMatchObject({ method: "notifications/progress", params: { progressToken: 42, progress: 0, total: FILES } });
  });

  describe("createProgress", () => {
    function harness() {
      let now = 0;
      const sent: Message[] = [];
      const controller = new AbortController();
      const progress = createProgress({ token: "t", signal: controller.signal, send: (params) => sent.push(params), now: () => now });
      return { sent, controller, progress, at: (ms: number) => (now = ms) };
    }

    test("sends at most one update per 250 ms and numbers unnumbered updates 1, 2, 3", () => {
      const { sent, progress, at } = harness();
      for (const ms of [0, 100, 249, 250, 300, 499, 500, 760]) {
        at(ms);
        progress.report({ message: `at ${ms}` });
      }
      expect(sent).toEqual([
        { progressToken: "t", progress: 1, message: "at 0" },
        { progressToken: "t", progress: 2, message: "at 250" },
        { progressToken: "t", progress: 3, message: "at 500" },
        { progressToken: "t", progress: 4, message: "at 760" },
      ]);
    });

    test("an explicit progress and total pass through", () => {
      const { sent, progress } = harness();
      progress.report({ message: "3 of 9", progress: 3, total: 9 });
      expect(sent).toEqual([{ progressToken: "t", progress: 3, total: 9, message: "3 of 9" }]);
    });

    test("nothing is sent after close or after the request is cancelled", () => {
      const closed = harness();
      closed.progress.close();
      closed.progress.report({ message: "late" });
      const cancelled = harness();
      cancelled.controller.abort();
      cancelled.progress.report({ message: "late" });
      expect([closed.sent, cancelled.sent]).toEqual([[], []]);
    });
  });
});

describe("shutdown", () => {
  // The handler has 100 ms in production, before the client's SIGTERM. A shared CI runner can stall a
  // process for several times that, so the specs allow 1 s: still a tenth of the registry lock's 10 s
  // default wait, the regression these timings exist to catch.
  const SHUTDOWN_BUDGET_MS = 1_000;
  const POSIX_SIGNALS_ONLY = "skipped on Windows: it has no POSIX signals, and the stdin-close spec covers it";

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    test.skipIf(process.platform === "win32")(`${signal} exits 0 through the shutdown handler within the shutdown budget (${POSIX_SIGNALS_ONLY})`, async () => {
      const server = startServer();
      await server.request("ping");
      const sent = performance.now();
      server.proc.kill(signal);
      const code = await server.proc.exited;
      const elapsed = performance.now() - sent;
      expect([code, server.proc.signalCode]).toEqual([0, null]);
      expect(elapsed).toBeLessThan(SHUTDOWN_BUDGET_MS);
    });
  }

  const OTHER_BINDING = { plan_name: "live", bound_at: Math.floor(Date.now() / 1000) };

  async function bindAcrossClear(server: Server): Promise<string> {
    await server.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "spec", version: "0" } });
    server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const plan = join(server.project, "live.md");
    writeFileSync(plan, "- [ ] 1. one\n");
    const registry = join(server.project, ".omca", "state", "boulder.json");
    writeFileSync(
      registry,
      JSON.stringify({ plans: { live: { active_plan: plan, started_at: "2026-10-02T10:00:00Z", session_ids: ["other"] } }, bindings: { other: OTHER_BINDING } }),
    );
    const call = (name: string, args: Message) => server.request("tools/call", { name, arguments: args });
    await call("boulder_write", { active_plan: plan, plan_name: "live", session_id: "before-clear" });
    await call("omca_hook", { event: "SessionStart", session_id: "after-clear", cwd: server.project, source: "clear" });
    await call("boulder_write", { active_plan: plan, plan_name: "live", session_id: "" });
    expect(Object.keys(JSON.parse(readFileSync(registry, "utf8")).bindings)).toEqual(["other", "before-clear", "after-clear"]);
    return registry;
  }

  async function interrupt(server: Server): Promise<{ elapsed: number; stderr: string }> {
    const sent = performance.now();
    server.proc.kill("SIGINT");
    expect(await server.proc.exited).toBe(0);
    const elapsed = performance.now() - sent;
    return { elapsed, stderr: await new Response(server.proc.stderr).text() };
  }

  test.skipIf(process.platform === "win32")(`SIGINT unbinds the session ids bound before and after /clear within the shutdown budget and leaves other sessions bound (${POSIX_SIGNALS_ONLY})`, async () => {
    const server = startServer();
    const registry = await bindAcrossClear(server);
    const { elapsed } = await interrupt(server);
    expect(elapsed).toBeLessThan(SHUTDOWN_BUDGET_MS);
    const { plans, bindings } = JSON.parse(readFileSync(registry, "utf8"));
    expect(bindings).toEqual({ other: OTHER_BINDING });
    expect(plans.live.session_ids).toEqual(["other", "before-clear", "after-clear"]);
  });

  test("closing stdin unbinds the session ids and exits 0, because Windows sends no signal", async () => {
    const server = startServer();
    const registry = await bindAcrossClear(server);
    server.proc.stdin.end();
    expect(await server.proc.exited).toBe(0);
    expect(server.proc.signalCode).toBeNull();
    const { bindings } = JSON.parse(readFileSync(registry, "utf8"));
    expect(bindings).toEqual({ other: OTHER_BINDING });
    expect(await new Response(server.proc.stderr).text()).toBe("");
  });

  test.skipIf(process.platform === "win32")(`SIGINT with the registry lock held skips the unbind, says so, and still exits 0 within the shutdown budget (${POSIX_SIGNALS_ONLY})`, async () => {
    const server = startServer();
    const registry = await bindAcrossClear(server);
    const before = readFileSync(registry, "utf8");
    writeFileSync(`${registry}.lock`, `${process.pid} ${Date.now()} spec-holder`);
    const { elapsed, stderr } = await interrupt(server);
    expect(elapsed).toBeLessThan(SHUTDOWN_BUDGET_MS);
    expect(readFileSync(registry, "utf8")).toBe(before);
    expect(stderr).toBe(`omca: ${registry}.lock stayed busy, so session ids before-clear, after-clear stay bound\n`);
  });
});
