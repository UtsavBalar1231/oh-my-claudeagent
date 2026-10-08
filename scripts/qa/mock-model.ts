#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isRecord } from "../../src/core/tool-input.ts";

const RESPONSE_TEXT = "ok";
const MOCK_MODEL_ID = "claude-mock";
const MESSAGE_ID = "msg_mock_static";
// Claude Code stamps `cc_is_subagent=true` into the billing-header block of every subagent
// request's system prompt and omits it from the main thread's.
const SUBAGENT_MARKER = "cc_is_subagent=true";

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: Record<string, unknown> };
// `delayMs` holds the reply back, so one agent can be made to finish after another's turn ends.
export type Turn = { content: Block[]; delayMs?: number };
type QueueName = "main" | "subagent";
// `agents` gives each subagent whose first message holds a key that key's own turns, so agents
// running at once do not race for one queue; any other subagent takes `subagent`.
export type Script = Record<QueueName, Turn[]> & { agents?: Record<string, Turn[]> };
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

function parseTurns(raw: unknown, queue: string): Turn[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`"${queue}" must be an array of turns`);
  return raw.map((turn, i) => {
    if (!isRecord(turn) || !Array.isArray(turn.content)) {
      throw new Error(`${queue}[${i}] needs a "content" array`);
    }
    const { delayMs } = turn;
    if (delayMs !== undefined && !(Number.isInteger(delayMs) && typeof delayMs === "number" && delayMs >= 0)) {
      throw new Error(`${queue}[${i}].delayMs must be a whole number of milliseconds`);
    }
    return {
      content: turn.content.map((block, j) => parseBlock(block, `${queue}[${i}].content[${j}]`)),
      ...(delayMs === undefined ? {} : { delayMs }),
    };
  });
}

export function parseScript(text: string): Script {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw)) throw new Error("the script must be a JSON object");
  const script: Script = { main: parseTurns(raw.main, "main"), subagent: parseTurns(raw.subagent, "subagent") };
  if (raw.agents === undefined) return script;
  if (!isRecord(raw.agents)) throw new Error('"agents" must map text in an agent\'s prompt to its turns');
  const agents = Object.entries(raw.agents).map(([key, turns]) => [key, parseTurns(turns, `agents.${key}`)] as const);
  return { ...script, agents: Object.fromEntries(agents) };
}

const stopReason = (content: Served[]) =>
  content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn";

// Usage is sized from the request and the reply at about four characters a token, so a session's
// token and cost displays show numbers of the size a real model would report.
const tokensOf = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

function jsonMessage(content: Served[], inputTokens: number) {
  return {
    id: MESSAGE_ID,
    type: "message",
    role: "assistant",
    content,
    model: MOCK_MODEL_ID,
    stop_reason: stopReason(content),
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: tokensOf(JSON.stringify(content)) },
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

function sseBody(content: Served[], inputTokens: number): string {
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
          usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
      },
    ],
    ...content.flatMap(blockEvents),
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: stopReason(content), stop_sequence: null },
        usage: { output_tokens: tokensOf(JSON.stringify(content)) },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
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

function firstMessageText(messages: unknown): string {
  const first: unknown = Array.isArray(messages) ? messages[0] : undefined;
  const content = isRecord(first) ? first.content : undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : "")).join("\n");
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

// Claude Code sends the effort as `output_config.effort`. The log carries the field only when
// the request does.
function effortField(body: Record<string, unknown>): { effort?: string | number } {
  const effort = isRecord(body.output_config) ? body.output_config.effort : undefined;
  return typeof effort === "string" || typeof effort === "number" ? { effort } : {};
}

export type ServerOptions = {
  port: number;
  accessLogPath?: string;
  bodyLogPath?: string;
  script?: Script;
};

export function startServer({
  port,
  accessLogPath,
  bodyLogPath,
  script = { main: [], subagent: [] },
}: ServerOptions): Bun.Server<undefined> {
  const queues = new Map<string, Turn[]>([
    ["main", script.main],
    ["subagent", script.subagent],
    ...Object.entries(script.agents ?? {}).map(([key, turns]) => [`agents.${key}`, turns] as const),
  ]);
  const cursor = new Map<string, number>();
  let toolSeq = 0;

  const queueOf = (queue: QueueName, messages: unknown): string => {
    if (queue === "main") return queue;
    const text = firstMessageText(messages);
    const key = Object.keys(script.agents ?? {}).find((candidate) => text.includes(candidate));
    return key === undefined ? queue : `agents.${key}`;
  };

  const serve = (queue: string): { turn: number | null; content: Served[]; delayMs?: number } => {
    const at = cursor.get(queue) ?? 0;
    const scripted = queues.get(queue)?.[at];
    if (!scripted) return { turn: null, content: [{ type: "text", text: RESPONSE_TEXT }] };
    const content = scripted.content.map((block): Served =>
      block.type === "text"
        ? block
        : { type: "tool_use", id: `toolu_mock_${++toolSeq}`, name: block.name, input: block.input },
    );
    cursor.set(queue, at + 1);
    return { turn: at, content, ...(scripted.delayMs === undefined ? {} : { delayMs: scripted.delayMs }) };
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
      // Claude Code counts tokens once a reply's usage is large enough; a count is not a model turn.
      if (url.pathname === "/v1/messages/count_tokens") return Response.json({ input_tokens: tokensOf(rawBody) });
      const body = parseBody(rawBody);
      const streaming = Boolean(body.stream);
      // Claude Code's side requests, such as naming the session, send an empty tools list. They get
      // the fallback reply and never spend a scripted turn.
      const isSide = Array.isArray(body.tools) && body.tools.length === 0;
      const queue = queueOf(systemText(body.system).includes(SUBAGENT_MARKER) ? "subagent" : "main", body.messages);
      const { turn, content, delayMs } = isSide ? { turn: null, content: [{ type: "text", text: RESPONSE_TEXT }] as Served[] } : serve(queue);

      if (accessLogPath) {
        appendFileSync(
          accessLogPath,
          jsonLine({
            client: server.requestIP(req)?.address ?? "",
            path: url.pathname + url.search,
            queue: isSide ? "side" : queue,
            turn,
            tool_results: countToolResults(body.messages),
            arrival_ms: arrived.getTime(),
            ...effortField(body),
          }),
        );
      }

      if (bodyLogPath) appendFileSync(bodyLogPath, `${JSON.stringify({ queue: isSide ? "side" : queue, turn, body: rawBody })}\n`);
      if (delayMs !== undefined) await Bun.sleep(delayMs);

      if (streaming) {
        return new Response(sseBody(content, tokensOf(rawBody)), {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        });
      }
      return Response.json(jsonMessage(content, tokensOf(rawBody)));
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
  });
  process.stdout.write(`${server.port}\n`);
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => process.exit(0));
}
