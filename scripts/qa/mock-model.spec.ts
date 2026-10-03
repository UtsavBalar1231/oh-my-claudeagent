import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Script, startServer, type Turn } from "./mock-model.ts";

const SCRIPT = join(import.meta.dir, "mock-model.ts");
const SUBAGENT_SYSTEM = [{ type: "text", text: "x-billing: cc_entrypoint=sdk-cli; cc_is_subagent=true;" }];

let dir: string;
let logPath: string;
let server: Bun.Server<undefined>;

const boot = async (options: { script?: Script; bodyLogPath?: string } = {}) => {
  await server?.stop(true);
  server = startServer({ port: 0, accessLogPath: logPath, ...options });
};

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers,
  });

const postJson = async (body: unknown = {}) => (await post("/v1/messages", body)).json();

const parseSse = (raw: string) =>
  raw
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => {
      const [event = "", data = ""] = frame.split("\n");
      return { event: event.slice("event: ".length), data: JSON.parse(data.slice("data: ".length)) as object };
    });

const postSse = async (body: unknown = { stream: true }) =>
  parseSse(await (await post("/v1/messages", body)).text());

const readLog = () => readFileSync(logPath, "utf8");
const logEntries = () =>
  readLog()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
const withoutArrival = (line: string) => line.replace(/"arrival_ms": \d+/, '"arrival_ms": 0');

const okText = [{ type: "text", text: "ok" }];
const bashTurn: Turn = { content: [{ type: "tool_use", name: "Bash", input: { command: "true" } }] };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mock-model-spec-"));
  logPath = join(dir, "access.log");
  await boot();
});

afterEach(async () => {
  await server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

describe("request body log", () => {
  test("records each request's queue, turn and raw body", async () => {
    const bodyLogPath = join(dir, "bodies.log");
    await boot({ bodyLogPath, script: { main: [{ content: [{ type: "text", text: "first" }] }], subagent: [] } });
    await post("/v1/messages", '{"messages":["x"]}');
    await post("/v1/messages", "not json");
    const lines = readFileSync(bodyLogPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { queue: "main", turn: 0, body: '{"messages":["x"]}' },
      { queue: "main", turn: null, body: "not json" },
    ]);
  });
});

describe("fixed reply without a script", () => {
  test("answers a plain request with the one-word assistant turn", async () => {
    const res = await post("/v1/messages?beta=true", { messages: [] });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("application/json");
    expect(await res.json()).toEqual({
      id: "msg_mock_static",
      type: "message",
      role: "assistant",
      content: okText,
      model: "claude-mock",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 4, output_tokens: 8 },
    });
  });

  test("sizes usage at about four characters a token of the request and the reply", async () => {
    const reply = (await postJson({ messages: ["x".repeat(4000)] })) as { usage: unknown };
    expect(reply.usage).toEqual({ input_tokens: 1005, output_tokens: 8 });
  });

  test("treats a malformed body as a non-streaming request", async () => {
    const res = await post("/v1/messages", "{not json");

    expect(res.status).toBe(200);
    expect(((await res.json()) as { content: unknown }).content).toEqual(okText);
    expect(logEntries()).toHaveLength(1);
  });

  test("sends event-stream headers for a streaming request", async () => {
    const res = await post("/v1/messages", { stream: true });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("streams the Messages API frames in order, carrying the reply text", async () => {
    const frames = await postSse();

    expect(frames.map((f) => f.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(frames[2]).toEqual({
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    });
    expect(frames[4]).toEqual({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 8 },
      },
    });
  });
});

describe("scripted turns", () => {
  test("serves a scripted text turn as end_turn", async () => {
    await boot({ script: { main: [{ content: [{ type: "text", text: "hello" }] }], subagent: [] } });

    const body = (await postJson()) as { content: unknown; stop_reason: unknown };

    expect(body.content).toEqual([{ type: "text", text: "hello" }]);
    expect(body.stop_reason).toBe("end_turn");
  });

  test("serves turns in order, one per request", async () => {
    await boot({
      script: {
        main: [
          { content: [{ type: "text", text: "one" }] },
          { content: [{ type: "text", text: "two" }] },
        ],
        subagent: [],
      },
    });

    const texts = [await postJson(), await postJson()].map((b) => (b as { content: { text: string }[] }).content[0]?.text);

    expect(texts).toEqual(["one", "two"]);
  });

  test("answers a token count without spending a turn or writing an access log line", async () => {
    await boot({ script: { main: [{ content: [{ type: "text", text: "one" }] }], subagent: [] } });

    const counted = await (await post("/v1/messages/count_tokens?beta=true", { messages: [] })).json();
    const reply = (await postJson()) as { content: { text: string }[] };

    expect(counted).toEqual({ input_tokens: 4 });
    expect(reply.content[0]?.text).toBe("one");
    expect(logEntries().map((entry) => entry.path)).toEqual(["/v1/messages"]);
  });

  test("serves a scripted tool_use turn as stop_reason tool_use with a mock id", async () => {
    await boot({ script: { main: [bashTurn], subagent: [] } });

    const body = (await postJson()) as { content: unknown; stop_reason: unknown };

    expect(body.content).toEqual([
      { type: "tool_use", id: "toolu_mock_1", name: "Bash", input: { command: "true" } },
    ]);
    expect(body.stop_reason).toBe("tool_use");
  });

  test("numbers tool_use ids across turns and queues", async () => {
    await boot({ script: { main: [bashTurn, bashTurn], subagent: [bashTurn] } });

    const ids = [
      await post("/v1/messages", {}),
      await post("/v1/messages", { system: SUBAGENT_SYSTEM }),
      await post("/v1/messages", {}),
    ];
    const bodies = (await Promise.all(ids.map((r) => r.json()))) as { content: { id: string }[] }[];

    expect(bodies.map((b) => b.content[0]?.id)).toEqual(["toolu_mock_1", "toolu_mock_2", "toolu_mock_3"]);
  });

  test("streams a tool_use turn with an empty-input start and the input as input_json_delta", async () => {
    await boot({
      script: {
        main: [
          {
            content: [
              { type: "text", text: "running" },
              { type: "tool_use", name: "Bash", input: { command: "echo hi", description: "greet" } },
            ],
          },
        ],
        subagent: [],
      },
    });

    const frames = await postSse();

    expect(frames.map((f) => f.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(frames[4]).toEqual({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_mock_1", name: "Bash", input: {} },
      },
    });
    const partialJson = frames
      .filter((f) => f.event === "content_block_delta" && (f.data as { index: number }).index === 1)
      .map((f) => ((f.data as { delta: { type: string; partial_json: string } }).delta.partial_json))
      .join("");
    expect(JSON.parse(partialJson)).toEqual({ command: "echo hi", description: "greet" });
    expect((frames[5]?.data as { delta: { type: string } } | undefined)?.delta.type).toBe("input_json_delta");
    expect((frames[7]?.data as { delta: { stop_reason: string } } | undefined)?.delta.stop_reason).toBe("tool_use");
  });

  test("falls back to the fixed ok reply once a queue is exhausted", async () => {
    await boot({ script: { main: [{ content: [{ type: "text", text: "only" }] }], subagent: [] } });

    await postJson();
    const body = (await postJson()) as { content: unknown; stop_reason: unknown };

    expect(body.content).toEqual(okText);
    expect(body.stop_reason).toBe("end_turn");
  });
});

describe("queue routing", () => {
  const twoQueues: Script = {
    main: [{ content: [{ type: "text", text: "main-reply" }] }],
    subagent: [{ content: [{ type: "text", text: "sub-reply" }] }],
  };
  const textOf = (body: unknown) => (body as { content: { text: string }[] }).content[0]?.text;

  test("routes a request whose system blocks carry the default marker to the subagent queue", async () => {
    await boot({ script: twoQueues });

    expect(textOf(await postJson({ system: SUBAGENT_SYSTEM }))).toBe("sub-reply");
  });

  test("routes a request whose string system carries the marker to the subagent queue", async () => {
    await boot({ script: twoQueues });

    expect(textOf(await postJson({ system: "you are cc_is_subagent=true" }))).toBe("sub-reply");
  });

  test("routes a request without the marker to the main queue", async () => {
    await boot({ script: twoQueues });

    expect(textOf(await postJson({ system: [{ type: "text", text: "main thread" }] }))).toBe("main-reply");
  });

  test("keeps the queues independent", async () => {
    await boot({ script: twoQueues });

    await postJson({ system: SUBAGENT_SYSTEM });

    expect(textOf(await postJson())).toBe("main-reply");
  });

  test("answers a subagent request with ok when the subagent queue is empty", async () => {
    await boot({ script: { main: twoQueues.main, subagent: [] } });

    expect(textOf(await postJson({ system: SUBAGENT_SYSTEM }))).toBe("ok");
  });
});

describe("routing", () => {
  test("answers a route other than /v1/messages with 404 and logs nothing", async () => {
    const res = await post("/v1/other", "{}");

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("mock-model.ts only serves /v1/messages");
    expect(() => readLog()).toThrow();
  });

  test("answers a non-POST method with 501", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/messages`);

    expect(res.status).toBe(501);
  });
});

describe("access log", () => {
  test("writes one JSONL line per request, with the key and value separators kept", async () => {
    await post("/v1/messages?beta=true", {}, { Authorization: "Bearer s3cret" });

    expect(withoutArrival(readLog())).toBe('{"client": "127.0.0.1", "path": "/v1/messages?beta=true", "queue": "main", "turn": null, "tool_results": 0, "arrival_ms": 0}\n');
  });

  test("records the arrival as epoch milliseconds between the send and the reply", async () => {
    const sent = Date.now();
    await post("/v1/messages", {});
    const replied = Date.now();

    const arrival = logEntries()[0]?.arrival_ms;
    expect(Number.isInteger(arrival)).toBe(true);
    expect(arrival as number).toBeGreaterThanOrEqual(sent);
    expect(arrival as number).toBeLessThanOrEqual(replied);
  });

  test("never logs a credential header's value", async () => {
    await post("/v1/messages", {}, { "X-Api-Key": "k3y", Authorization: "Bearer s3cret" });

    const line = readLog();
    expect(line).not.toContain("k3y");
    expect(line).not.toContain("s3cret");
  });

  test("appends successive requests in arrival order", async () => {
    await post("/v1/messages?n=1", {});
    await post("/v1/messages?n=2", {});

    expect(logEntries().map((e) => e.path)).toEqual(["/v1/messages?n=1", "/v1/messages?n=2"]);
  });

  test("logs the queue and the served turn index, null on the fallback", async () => {
    await boot({
      script: {
        main: [{ content: [{ type: "text", text: "a" }] }],
        subagent: [{ content: [{ type: "text", text: "b" }] }, { content: [{ type: "text", text: "c" }] }],
      },
    });

    await postJson();
    await postJson();
    await postJson({ system: SUBAGENT_SYSTEM });
    await postJson({ system: SUBAGENT_SYSTEM });
    await postJson({ system: SUBAGENT_SYSTEM });

    expect(logEntries().map((e) => [e.queue, e.turn])).toEqual([
      ["main", 0],
      ["main", null],
      ["subagent", 0],
      ["subagent", 1],
      ["subagent", null],
    ]);
  });

  test("logs the count of tool_result blocks in the last user message only", async () => {
    const result = (id: string) => ({ type: "tool_result", tool_use_id: id, content: "" });
    await post("/v1/messages", {
      messages: [
        { role: "user", content: [result("a"), result("b"), result("c")] },
        { role: "assistant", content: [{ type: "text", text: "next" }] },
        { role: "user", content: [result("d"), result("e"), { type: "text", text: "and more" }] },
        { role: "system", content: [{ type: "text", text: "reminder" }] },
      ],
    });

    expect(logEntries()[0]?.tool_results).toBe(2);
  });

  test("logs zero tool_results for string content or no messages", async () => {
    await post("/v1/messages", { messages: [{ role: "user", content: "hi" }] });
    await post("/v1/messages", { messages: [] });

    expect(logEntries().map((e) => e.tool_results)).toEqual([0, 0]);
  });

  test("logs the effort a request's output_config carries, and no effort field without one", async () => {
    await post("/v1/messages", { output_config: { effort: "low" } });
    await post("/v1/messages", { output_config: {} });
    await post("/v1/messages", {});

    expect(logEntries().map((e) => e.effort)).toEqual(["low", undefined, undefined]);
    expect(readLog().match(/"effort"/g)).toEqual(['"effort"']);
  });
});

describe("command line", () => {
  const spawned: ReturnType<typeof Bun.spawn>[] = [];
  const spawnMock = (...args: string[]) => {
    const proc = Bun.spawn([process.execPath, SCRIPT, ...args], { env: process.env, stdout: "pipe", stderr: "pipe" });
    spawned.push(proc);
    return proc;
  };

  afterEach(() => {
    for (const proc of spawned.splice(0)) proc.kill("SIGTERM");
  });

  const readPort = async (proc: ReturnType<typeof spawnMock>) => {
    const first = new TextDecoder().decode((await proc.stdout.getReader().read()).value);
    return Number(first.trim());
  };

  const scriptFile = (contents: string) => {
    const path = join(dir, "script.json");
    writeFileSync(path, contents);
    return path;
  };

  test.skipIf(process.platform === "win32")("prints the bound port as its first line, serves on it, and exits 0 on SIGTERM (skipped on Windows: it has no SIGTERM)", async () => {
    const proc = spawnMock("--port", "0");
    const port = await readPort(proc);
    expect(Number.isInteger(port) && port > 0).toBe(true);

    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);

    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
  });

  test("serves the turns of --script on the printed port", async () => {
    const path = scriptFile(JSON.stringify({ main: [{ content: [{ type: "text", text: "from file" }] }] }));
    const proc = spawnMock("--port", "0", "--script", path);
    const port = await readPort(proc);

    const body = (await (await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", body: "{}" })).json()) as {
      content: unknown;
    };

    expect(body.content).toEqual([{ type: "text", text: "from file" }]);
  });

  test("rejects a non-numeric --port with exit code 2", async () => {
    const proc = spawnMock("--port", "abc");

    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toBe("mock-model.ts: invalid --port: abc\n");
  });

  test("rejects a --script that is not JSON with exit code 2 and names the file", async () => {
    const path = scriptFile("{not json");
    const proc = spawnMock("--script", path);

    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toStartWith(`mock-model.ts: invalid --script ${path}: `);
  });

  test("rejects a --script with an unknown block type and says which block", async () => {
    const path = scriptFile(JSON.stringify({ main: [{ content: [{ type: "image" }] }] }));
    const proc = spawnMock("--script", path);

    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toBe(
      `mock-model.ts: invalid --script ${path}: main[0].content[0] is not a text block or a tool_use block with an object input\n`,
    );
  });

  test("rejects a --script whose queue is not an array of turns", async () => {
    const path = scriptFile(JSON.stringify({ subagent: "nope" }));
    const proc = spawnMock("--script", path);

    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toBe(
      `mock-model.ts: invalid --script ${path}: "subagent" must be an array of turns\n`,
    );
  });

  test("rejects a --script file that does not exist", async () => {
    const proc = spawnMock("--script", join(dir, "missing.json"));

    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toStartWith("mock-model.ts: invalid --script ");
  });
});
