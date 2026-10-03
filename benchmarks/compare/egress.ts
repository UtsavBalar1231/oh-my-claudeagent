import { createConnection, createServer, type Socket } from "node:net";

export const ALLOWED_ENDPOINTS: readonly string[] = ["api.anthropic.com:443"];

const MAX_HEAD_BYTES = 8192;
const HEAD_END = "\r\n\r\n";

export type Attempt = { target: string; allowed: boolean };
export type EgressProxy = { port: number; attempts: Attempt[]; stop: () => Promise<void> };

export function parseConnect(requestLine: string): string | null {
  const match = /^CONNECT (\S+) HTTP\/1\.[01]$/.exec(requestLine);
  if (match === null) return null;
  const target = /^(\[[0-9a-fA-F:.]+\]|[^:\s[\]]+):(\d{1,5})$/.exec(match[1] as string);
  if (target === null || Number(target[2]) > 65535) return null;
  return `${(target[1] as string).toLowerCase()}:${Number(target[2])}`;
}

export function startEgressProxy(options: { hostname: string; allowed: readonly string[] }): Promise<EgressProxy> {
  const attempts: Attempt[] = [];
  const open = new Set<Socket>();
  const track = (socket: Socket): void => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    socket.on("error", () => socket.destroy());
  };
  const refuse = (client: Socket, status: string): void => {
    client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  };

  const server = createServer((client) => {
    track(client);
    let head = "";
    const onData = (chunk: Buffer): void => {
      head += chunk.toString("latin1");
      const end = head.indexOf(HEAD_END);
      if (end < 0) {
        if (head.length > MAX_HEAD_BYTES) refuse(client, "431 Request Header Fields Too Large");
        return;
      }
      client.off("data", onData);
      client.pause();
      const requestLine = head.slice(0, head.indexOf("\r\n"));
      const target = parseConnect(requestLine);
      const allowed = target !== null && options.allowed.includes(target);
      attempts.push({ target: target ?? requestLine, allowed });
      if (target === null || !allowed) {
        refuse(client, "403 Forbidden");
        return;
      }
      const separator = target.lastIndexOf(":");
      const upstream = createConnection({ host: target.slice(0, separator).replace(/^\[|\]$/g, ""), port: Number(target.slice(separator + 1)) });
      track(upstream);
      let connected = false;
      upstream.once("connect", () => {
        connected = true;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const early = Buffer.from(head.slice(end + HEAD_END.length), "latin1");
        if (early.length > 0) upstream.write(early);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
      upstream.once("error", () => {
        if (!connected) refuse(client, "502 Bad Gateway");
      });
      client.once("close", () => upstream.destroy());
      upstream.once("close", () => client.destroy());
    };
    client.on("data", onData);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, options.hostname, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("egress proxy has no TCP address"));
        return;
      }
      resolve({
        port: address.port,
        attempts,
        stop: () =>
          new Promise<void>((done) => {
            for (const socket of open) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
