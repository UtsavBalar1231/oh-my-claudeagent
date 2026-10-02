const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export type Params = Record<string, unknown>;
export type Handler = (params: Params) => unknown;

type Id = string | number | null;

export class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is Id =>
  typeof value === "string" || typeof value === "number" || value === null;

export function createDispatcher(
  handlers: Record<string, Handler>,
  send: (line: string) => void,
): (chunk: string) => void {
  const reply = (id: Id, body: { result: unknown } | { error: { code: number; message: string } }) =>
    send(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);

  async function dispatch(message: unknown): Promise<void> {
    const id = isObject(message) ? message.id : undefined;
    if (id !== undefined && !isId(id)) {
      reply(null, { error: { code: INVALID_REQUEST, message: "Invalid Request" } });
      return;
    }
    if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      reply(id ?? null, { error: { code: INVALID_REQUEST, message: "Invalid Request" } });
      return;
    }
    const { method } = message;
    const params = message.params ?? {};
    try {
      if (!isObject(params)) throw new RpcError(INVALID_PARAMS, `${method}: params must be an object`);
      const handler = handlers[method];
      if (!handler) throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
      const result = await handler(params);
      if (id !== undefined) reply(id, { result: result ?? null });
    } catch (error) {
      if (!(error instanceof RpcError)) console.error(`omca: ${method} failed:`, error);
      if (id === undefined) return;
      const code = error instanceof RpcError ? error.code : INTERNAL_ERROR;
      reply(id, { error: { code, message: error instanceof Error ? error.message : String(error) } });
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
