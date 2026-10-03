import { isRecord } from "../src/core/tool-input.ts";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const CANCELLED = "notifications/cancelled";

export type Params = Record<string, unknown>;
export type Context = {
  /** Aborts when the client cancels this request; the dispatcher then sends no reply. */
  signal: AbortSignal;
  notify: (method: string, params: Params) => void;
};
export type Handler = (params: Params, context: Context) => unknown;

type Id = string | number | null;
type ErrorBody = { code: number; message: string; data?: unknown };

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const isId = (value: unknown): value is Id =>
  typeof value === "string" || typeof value === "number" || value === null;

export function createDispatcher(
  handlers: Record<string, Handler>,
  send: (line: string) => void,
): (chunk: string) => void {
  const reply = (id: Id, body: { result: unknown } | { error: ErrorBody }) =>
    send(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);
  const notify = (method: string, params: Params) => send(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  const inflight = new Map<Id, AbortController>();

  async function dispatch(message: unknown): Promise<void> {
    const id = isRecord(message) ? message.id : undefined;
    if (id !== undefined && !isId(id)) {
      reply(null, { error: { code: INVALID_REQUEST, message: "Invalid Request" } });
      return;
    }
    if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      reply(id ?? null, { error: { code: INVALID_REQUEST, message: "Invalid Request" } });
      return;
    }
    const { method } = message;
    const params = message.params ?? {};
    if (id === undefined && method === CANCELLED) {
      if (isRecord(params) && isId(params.requestId)) inflight.get(params.requestId)?.abort();
      return;
    }
    const controller = new AbortController();
    if (id !== undefined) inflight.set(id, controller);
    try {
      if (!isRecord(params)) throw new RpcError(INVALID_PARAMS, `${method}: params must be an object`);
      const handler = handlers[method];
      if (!handler) throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
      const result = await handler(params, { signal: controller.signal, notify });
      if (id !== undefined && !controller.signal.aborted) reply(id, { result: result ?? null });
    } catch (error) {
      if (!(error instanceof RpcError) && !controller.signal.aborted) console.error(`omca: ${method} failed:`, error);
      if (id === undefined || controller.signal.aborted) return;
      const text = error instanceof Error ? error.message : String(error);
      reply(id, { error: error instanceof RpcError ? { code: error.code, message: text, data: error.data } : { code: INTERNAL_ERROR, message: text } });
    } finally {
      if (id !== undefined && inflight.get(id) === controller) inflight.delete(id);
    }
  }

  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === "") continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        reply(null, { error: { code: PARSE_ERROR, message: "Parse error" } });
        continue;
      }
      dispatch(message).catch((error: unknown) => console.error("omca: could not send a reply:", error));
    }
  };
}
