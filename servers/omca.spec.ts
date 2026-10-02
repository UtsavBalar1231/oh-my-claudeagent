import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDispatcher, type Handler } from "./jsonrpc.ts";

const SERVER = join(import.meta.dir, "omca.ts");
const CLIENT_TEXT_CAP_CHARS = 2048;
const MAX_RESULT_SIZE_CEILING = 500_000;
const MAX_RESULT_SIZE_TOOLS = ["evidence_read", "file_read", "ast_search", "session_search"];
const WRITE_TOOLS = ["ast_replace", "boulder_write", "evidence_log", "omca_hook", "notepad_write", "notepad_compact"];
const ALL_TOOLS = [
  "ast_search",
  "ast_replace",
  "ast_find_rule",
  "ast_dump_tree",
  "ast_test_rule",
  "boulder_write",
  "boulder_progress",
  "health_check",
  "evidence_log",
  "evidence_read",
  "omca_hook",
  "notepad_write",
  "notepad_read",
  "notepad_list",
  "notepad_compact",
];
const PROPERTY_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

const VERSION: string = JSON.parse(readFileSync(join(import.meta.dir, "..", ".claude-plugin", "plugin.json"), "utf8")).version;
const PYTHON_INSTRUCTIONS = (() => {
  const source = readFileSync(join(import.meta.dir, "omca-mcp.py"), "utf8");
  const literal = /^INSTRUCTIONS = """\\\n([\s\S]*?)"""$/m.exec(source)?.[1];
  if (literal === undefined) throw new Error("INSTRUCTIONS literal not found in omca-mcp.py");
  return literal.replaceAll("\\\n", "");
})();

const OMCA_HOOK = {
  name: "omca_hook",
  description: "Internal: OMCA's settings hooks call this. Not for direct use.",
  inputSchema: {
    type: "object",
    properties: { event: { type: "string" } },
    required: ["event"],
    additionalProperties: { type: "string" },
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

type Message = Record<string, unknown>;
type Reply = { jsonrpc: string; id: number | null; result?: unknown; error?: unknown };
type ToolDeclaration = {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown> };
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
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

afterEach(() => {
  for (const server of running.splice(0)) {
    server.proc.kill("SIGKILL");
    rmSync(server.project, { recursive: true, force: true });
  }
});

function startServer(role?: "hooks"): Server {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "omca-server-")));
  expect(Bun.spawnSync(["git", "init", "-q", project]).exitCode).toBe(0);
  const env = { ...process.env };
  delete env.OMCA_SERVER_ROLE;
  if (role) env.OMCA_SERVER_ROLE = role;
  const proc = Bun.spawn([process.execPath, SERVER], { cwd: project, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
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
        instructions: PYTHON_INSTRUCTIONS,
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
      instructions: PYTHON_INSTRUCTIONS,
    });
    server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect((await server.request("ping")).result).toEqual({});
  });

  test("initialize without a protocol version is an invalid-params error", async () => {
    const server = startServer();
    expect((await server.request("initialize", {})).error).toEqual({
      code: -32602,
      message: "initialize: protocolVersion must be a string",
    });
  });

  test("the hooks role sends no instructions, since the Python server already does", async () => {
    const server = startServer("hooks");
    expect((await server.request("initialize", { protocolVersion: "2025-11-25" })).result).toEqual({
      protocolVersion: "2025-11-25",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "omca", version: VERSION },
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
    const server = startServer("hooks");
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
  test("the hooks role lists exactly health_check and omca_hook, filtering out every other tool", async () => {
    expect((await listTools(startServer("hooks"))).map((tool) => tool.name)).toEqual(["health_check", "omca_hook"]);
    expect((await listTools(startServer())).length).toBeGreaterThan(2);
  });

  test("without a role the server lists every declared tool", async () => {
    expect((await listTools(startServer())).map((tool) => tool.name)).toEqual(ALL_TOOLS);
  });

  test("tools/list tells the client not to cache the list and marks the result complete", async () => {
    expect((await startServer().request("tools/list")).result).toMatchObject({
      ttlMs: 0,
      cacheScope: "private",
      resultType: "complete",
    });
  });

  test("omca_hook is declared exactly", async () => {
    expect((await listTools(startServer("hooks"))).find((tool) => tool.name === "omca_hook")).toEqual(OMCA_HOOK);
  });

  test("omca_hook answers an empty hook result", async () => {
    const server = startServer("hooks");
    expect((await server.request("tools/call", { name: "omca_hook", arguments: { event: "Stop" } })).result).toEqual({
      content: [{ type: "text", text: "{}" }],
      resultType: "complete",
    });
  });

  test("omca_hook without an event is a tool error, not a protocol error", async () => {
    const server = startServer("hooks");
    expect((await server.request("tools/call", { name: "omca_hook", arguments: {} })).result).toEqual({
      content: [{ type: "text", text: "omca_hook: event must be a string" }],
      isError: true,
      resultType: "complete",
    });
  });

  test("an unknown tool and non-object arguments are invalid-params errors", async () => {
    const server = startServer("hooks");
    expect((await server.request("tools/call", { name: "evidence_log", arguments: {} })).error).toEqual({
      code: -32602,
      message: "Unknown tool: evidence_log",
    });
    expect((await server.request("tools/call", { name: "omca_hook", arguments: "x" })).error).toEqual({
      code: -32602,
      message: "omca_hook: arguments must be an object",
    });
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

  test("the server instructions fit the client cap", () => {
    expect(PYTHON_INSTRUCTIONS.length).toBeLessThanOrEqual(CLIENT_TEXT_CAP_CHARS);
  });
});

describe("shutdown", () => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    test(`${signal} exits 0 through the shutdown handler within 100 ms`, async () => {
      const server = startServer();
      await server.request("ping");
      const sent = performance.now();
      server.proc.kill(signal);
      const code = await server.proc.exited;
      const elapsed = performance.now() - sent;
      expect([code, server.proc.signalCode]).toEqual([0, null]);
      expect(elapsed).toBeLessThan(100);
    });
  }
});
