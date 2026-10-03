import { afterEach, describe, expect, test } from "bun:test";
import { connect, createServer, type Server } from "node:net";
import { type EgressProxy, parseConnect, startEgressProxy } from "./egress.ts";

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

function listen(onConnection: () => void): Promise<{ port: number; server: Server }> {
  const server = createServer((socket) => {
    onConnection();
    socket.on("data", (chunk) => socket.write(chunk));
    socket.on("error", () => socket.destroy());
  });
  closers.push(() => new Promise<void>((done) => server.close(() => done())));
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as { port: number }).port, server })));
}

async function proxyFor(allowed: string[]): Promise<EgressProxy> {
  const proxy = await startEgressProxy({ hostname: "127.0.0.1", allowed });
  closers.push(() => proxy.stop());
  return proxy;
}

function client(port: number) {
  const socket = connect(port, "127.0.0.1");
  let received = "";
  const waiting: { text: string; resolve: (all: string) => void }[] = [];
  const settle = (): void => {
    for (const w of waiting.splice(0)) {
      if (received.includes(w.text)) w.resolve(received);
      else waiting.push(w);
    }
  };
  socket.on("data", (chunk) => {
    received += chunk.toString("latin1");
    settle();
  });
  socket.on("close", () => {
    for (const w of waiting.splice(0)) w.resolve(received);
  });
  socket.on("error", () => socket.destroy());
  closers.push(() => void socket.destroy());
  return {
    send: (text: string): void => void socket.write(text),
    waitFor: (text: string): Promise<string> =>
      new Promise((resolve) => {
        waiting.push({ text, resolve });
        settle();
      }),
  };
}

describe("parseConnect", () => {
  test("returns a lower-cased host and a numeric port", () => {
    expect(parseConnect("CONNECT API.Anthropic.COM:443 HTTP/1.1")).toBe("api.anthropic.com:443");
    expect(parseConnect("CONNECT [::1]:443 HTTP/1.0")).toBe("[::1]:443");
  });

  test("refuses anything that is not a CONNECT with a host and a port in range", () => {
    for (const line of ["GET http://example.com/ HTTP/1.1", "CONNECT example.com HTTP/1.1", "CONNECT example.com:99999 HTTP/1.1", "CONNECT example.com:443 HTTP/2", "connect example.com:443 HTTP/1.1"]) {
      expect(parseConnect(line)).toBeNull();
    }
  });
});

describe("egress proxy", () => {
  test("tunnels bytes to an allowed target and records the attempt", async () => {
    const upstream = await listen(() => {});
    const proxy = await proxyFor([`127.0.0.1:${upstream.port}`]);
    const c = client(proxy.port);
    c.send(`CONNECT 127.0.0.1:${upstream.port} HTTP/1.1\r\nHost: x\r\n\r\n`);
    expect(await c.waitFor("\r\n\r\n")).toStartWith("HTTP/1.1 200 Connection Established");
    c.send("ping");
    expect((await c.waitFor("ping")).endsWith("ping")).toBe(true);
    expect(proxy.attempts).toEqual([{ target: `127.0.0.1:${upstream.port}`, allowed: true }]);
  });

  test("waits for the end of a header that arrives in two pieces", async () => {
    const upstream = await listen(() => {});
    const proxy = await proxyFor([`127.0.0.1:${upstream.port}`]);
    const c = client(proxy.port);
    c.send(`CONNECT 127.0.0.1:${upstream.port} HTTP/1.1\r\n`);
    await Bun.sleep(30);
    c.send("\r\n");
    expect(await c.waitFor("\r\n\r\n")).toStartWith("HTTP/1.1 200");
  });

  test("refuses an unlisted host, an unlisted port and a plain request without connecting", async () => {
    let connections = 0;
    const upstream = await listen(() => {
      connections += 1;
    });
    const proxy = await proxyFor([`127.0.0.1:${upstream.port}`]);
    const attempts = ["CONNECT example.com:443 HTTP/1.1", `CONNECT 127.0.0.1:${upstream.port + 1} HTTP/1.1`, `GET http://127.0.0.1:${upstream.port}/ HTTP/1.1`];
    for (const line of attempts) {
      const c = client(proxy.port);
      c.send(`${line}\r\nHost: x\r\n\r\n`);
      expect(await c.waitFor("\r\n\r\n")).toStartWith("HTTP/1.1 403 Forbidden");
    }
    expect(connections).toBe(0);
    expect(proxy.attempts).toEqual([
      { target: "example.com:443", allowed: false },
      { target: `127.0.0.1:${upstream.port + 1}`, allowed: false },
      { target: `GET http://127.0.0.1:${upstream.port}/ HTTP/1.1`, allowed: false },
    ]);
  });

  test("answers 502 when an allowed target does not accept the connection", async () => {
    const closed = await listen(() => {});
    const port = closed.port;
    await new Promise<void>((done) => closed.server.close(() => done()));
    const proxy = await proxyFor([`127.0.0.1:${port}`]);
    const c = client(proxy.port);
    c.send(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\n\r\n`);
    expect(await c.waitFor("\r\n\r\n")).toStartWith("HTTP/1.1 502 Bad Gateway");
  });

  test("stops accepting connections after stop", async () => {
    const proxy = await startEgressProxy({ hostname: "127.0.0.1", allowed: [] });
    await proxy.stop();
    const refused = await new Promise<boolean>((resolve) => {
      const socket = connect(proxy.port, "127.0.0.1");
      socket.on("connect", () => {
        socket.destroy();
        resolve(false);
      });
      socket.on("error", () => resolve(true));
    });
    expect(refused).toBe(true);
  });
});
