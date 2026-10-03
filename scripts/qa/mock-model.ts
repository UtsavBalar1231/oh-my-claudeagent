#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isRecord } from "../../src/core/tool-input.ts";

const RESPONSE_TEXT = "ok";
const MOCK_MODEL_ID = "claude-mock";
const MESSAGE_ID = "msg_mock_static";
const CREDENTIAL_HEADERS = ["authorization", "x-api-key"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Claude Code stamps `cc_is_subagent=true` into the billing-header block of every subagent
// request's system prompt and omits it from the main thread's (measured on 2.1.287).
const DEFAULT_SUBAGENT_MARKER = "cc_is_subagent=true";

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: Record<string, unknown> };
export type Turn = { content: Block[] };
type QueueName = "main" | "subagent";
export type Script = Record<QueueName, Turn[]>;
type Served =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
type LogValue = string | boolean | number | null;

function parseBlock(raw: unknown, where: string): Block {
  if (isRecord(raw) && raw.type === "text" && typeof raw.text === "string") {
    return { type: "text", text: raw.text };
  }
  if (isRecord(raw) && raw.type === "tool_use" && typeof raw.name === "string" && isRecord(raw.input)) {
    return { type: "tool_use", name: raw.name, input: raw.input };
  }
  throw new Error(`${where} is not a text block or a tool_use block with an object input`);
}

function parseTurns(raw: unknown, queue: QueueName): Turn[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`"${queue}" must be an array of turns`);
  return raw.map((turn, i) => {
    if (!isRecord(turn) || !Array.isArray(turn.content)) {
      throw new Error(`${queue}[${i}] needs a "content" array`);
    }
    return {
      content: turn.content.map((block, j) => parseBlock(block, `${queue}[${i}].content[${j}]`)),
    };
  });
}

export function parseScript(text: string): Script {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw)) throw new Error("the script must be a JSON object");
  return { main: parseTurns(raw.main, "main"), subagent: parseTurns(raw.subagent, "subagent") };
}

const stopReason = (content: Served[]) =>
  content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn";

function jsonMessage(content: Served[]) {
  return {
    id: MESSAGE_ID,
    type: "message",
    role: "assistant",
    content,
    model: MOCK_MODEL_ID,
    stop_reason: stopReason(content),
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

type SseEvent = [string, object];

function blockEvents(block: Served, index: number): SseEvent[] {
  const start =
    block.type === "text"
      ? { type: "text", text: "" }
      : { type: "tool_use", id: block.id, name: block.name, input: {} };
  const delta =
    block.type === "text"
      ? { type: "text_delta", text: block.text }
      : { type: "input_json_delta", partial_json: JSON.stringify(block.input) };
  return [
    ["content_block_start", { type: "content_block_start", index, content_block: start }],
    ["content_block_delta", { type: "content_block_delta", index, delta }],
    ["content_block_stop", { type: "content_block_stop", index }],
  ];
}

function sseBody(content: Served[]): string {
  const events: SseEvent[] = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: MESSAGE_ID,
          type: "message",
          role: "assistant",
          content: [],
          model: MOCK_MODEL_ID,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    ],
    ...content.flatMap(blockEvents),
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: stopReason(content), stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function arrivalTime(d: Date): string {
  const date = `${pad2(d.getDate())}/${MONTHS[d.getMonth()]}/${d.getFullYear()}`;
  return `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// Entries keep the `": "` and `", "` separators JSON.stringify would drop, so the log stays
// greppable by key and value.
function jsonLine(entry: Record<string, LogValue>): string {
  const fields = Object.entries(entry).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return `{${fields.join(", ")}}\n`;
}

function parseBody(text: string): Record<string, unknown> {
  try {
    const body: unknown = JSON.parse(text);
    return isRecord(body) ? body : {};
  } catch {
    return {};
  }
}

function systemText(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system.map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : "")).join("\n");
}

// Claude Code sometimes appends a system-role reminder after the user message that carries
// the tool results, so the count reads the last user message, not the last message.
function countToolResults(messages: unknown): number {
  const lastUser = Array.isArray(messages)
    ? messages.findLast((m) => isRecord(m) && m.role === "user")
    : undefined;
  const content = isRecord(lastUser) ? lastUser.content : undefined;
  return Array.isArray(content) ? content.filter((b) => isRecord(b) && b.type === "tool_result").length : 0;
}

// Claude Code sends the effort as `output_config.effort` (measured on 2.1.287). The log
// carries the field only when the request does.
function effortField(body: Record<string, unknown>): { effort?: string | number } {
  const effort = isRecord(body.output_config) ? body.output_config.effort : undefined;
  return typeof effort === "string" || typeof effort === "number" ? { effort } : {};
}

export type ServerOptions = {
  port: number;
  accessLogPath?: string;
  bodyLogPath?: string;
  script?: Script;
  subagentMarker?: string;
};

export function startServer({
  port,
  accessLogPath,
  bodyLogPath,
  script = { main: [], subagent: [] },
  subagentMarker = DEFAULT_SUBAGENT_MARKER,
}: ServerOptions): Bun.Server<undefined> {
  const cursor: Record<QueueName, number> = { main: 0, subagent: 0 };
  let toolSeq = 0;

  const serve = (queue: QueueName): { turn: number | null; content: Served[] } => {
    const scripted = script[queue][cursor[queue]];
    if (!scripted) return { turn: null, content: [{ type: "text", text: RESPONSE_TEXT }] };
    const content = scripted.content.map((block): Served =>
      block.type === "text"
        ? block
        : { type: "tool_use", id: `toolu_mock_${++toolSeq}`, name: block.name, input: block.input },
    );
    return { turn: cursor[queue]++, content };
  };

  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req, server) {
      const arrived = new Date();
      if (req.method !== "POST") return new Response("Unsupported method", { status: 501 });
      const url = new URL(req.url);
      if (!url.pathname.startsWith("/v1/messages")) {
        return new Response("mock-model.ts only serves /v1/messages", { status: 404 });
      }

      const rawBody = await req.text();
      const body = parseBody(rawBody);
      const streaming = Boolean(body.stream);
      const queue: QueueName = systemText(body.system).includes(subagentMarker) ? "subagent" : "main";
      const { turn, content } = serve(queue);

      if (accessLogPath) {
        appendFileSync(
          accessLogPath,
          jsonLine({
            ts: arrivalTime(arrived),
            client: server.requestIP(req)?.address ?? "",
            method: "POST",
            path: url.pathname + url.search,
            mode: streaming ? "sse" : "json",
            has_credential: CREDENTIAL_HEADERS.some((h) => req.headers.has(h)),
            queue,
            turn,
            tool_results: countToolResults(body.messages),
            arrival_ms: arrived.getTime(),
            ...effortField(body),
          }),
        );
      }

      if (bodyLogPath) appendFileSync(bodyLogPath, `${JSON.stringify({ queue, turn, body: rawBody })}\n`);

      if (streaming) {
        return new Response(sseBody(content), {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        });
      }
      return Response.json(jsonMessage(content));
    },
  });
}

function loadScript(path: string): Script {
  try {
    return parseScript(readFileSync(path, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`mock-model.ts: invalid --script ${path}: ${reason}`);
    process.exit(2);
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "0" },
      "access-log": { type: "string" },
      script: { type: "string" },
      "subagent-marker": { type: "string" },
    },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`mock-model.ts: invalid --port: ${values.port}`);
    process.exit(2);
  }
  const script = values.script === undefined ? undefined : loadScript(values.script);

  const server = startServer({
    port,
    ...(values["access-log"] !== undefined && { accessLogPath: values["access-log"] }),
    ...(script !== undefined && { script }),
    ...(values["subagent-marker"] !== undefined && { subagentMarker: values["subagent-marker"] }),
  });
  process.stdout.write(`${server.port}\n`);
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => process.exit(0));
}
