import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Run } from "./core.ts";
import { cleanup, fixture, json, runNamed } from "./fixture.ts";
import { checks, judgeHandshake } from "./mcp.ts";

afterEach(cleanup);

const stub = (body: string) => `import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const root = dirname(dirname(process.argv[1] ?? ""));
writeFileSync(join(root, "cwd.txt"), process.cwd());
if (existsSync(join(process.cwd(), "servers", "omca.ts"))) process.exit(3);
const requests = (await Bun.stdin.text()).split("\\n").filter(Boolean).map((line) => JSON.parse(line));
const reply = (message) => console.log(JSON.stringify(message));
${body}
`;

const LISTING = `for (const request of requests) {
  if (request.method === "initialize") reply({ jsonrpc: "2.0", id: request.id, result: {} });
  if (request.method === "tools/list") reply({ jsonrpc: "2.0", id: request.id, result: { tools: TOOLS.map((name) => ({ name })) } });
}`;

const server = (tools: string[]) => stub(`const TOOLS = ${JSON.stringify(tools)};\n${LISTING}`);

const files = (omca: string) => ({
  "servers/omca.ts": omca,
  "tests/fixtures/mcp/initialize.json": json({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  "tests/fixtures/mcp/initialized-notification.json": json({ jsonrpc: "2.0", method: "notifications/initialized" }),
  "tests/fixtures/mcp/tools-list.json": json({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  "tests/fixtures/mcp/expected-tools.json": json(["alpha", "beta"]),
});

const handshake = (omca: string) => runNamed(checks, "mcp handshake", fixture(files(omca)));

const run = (stdout: string, code = 0, stderr = ""): Run => ({ code, stdout, stderr });
const answers = (...ids: number[]) => ids.map((id) => JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [{ name: "alpha" }, { name: "beta" }] } })).join("\n");

describe("mcp handshake against a server process", () => {
  test("a server that answers initialize and lists every expected tool passes", async () => {
    expect(await handshake(server(["alpha", "beta", "gamma"]))).toEqual({
      status: "pass",
      detail: "initialize and tools/list answered, 2 expected tools listed",
    });
  });

  test("an expected tool the server does not list fails and is named", async () => {
    expect(await handshake(server(["alpha"]))).toEqual({ status: "fail", detail: "tools/list is missing beta" });
  });

  test("a server that answers nothing fails", async () => {
    expect(await handshake(stub(""))).toEqual({ status: "fail", detail: "the handshake returned empty stdout" });
  });

  test("a server that prints a line that is not JSON fails", async () => {
    expect(await handshake(stub('console.log("starting up");'))).toEqual({
      status: "fail",
      detail: "the handshake stdout is not valid JSON lines",
    });
  });

  test("a server that exits non-zero fails with the first lines of its stderr", async () => {
    expect(await handshake(stub('console.error("boom");\nprocess.exit(7);'))).toEqual({
      status: "fail",
      detail: "the handshake command exited 7 (boom)",
    });
  });

  test("the server runs in a scratch directory that is gone afterwards", async () => {
    const ctx = fixture(files(server(["alpha", "beta"])));
    expect(await checks[0]?.run(ctx)).toMatchObject({ status: "pass" });
    const scratch = readFileSync(join(ctx.root, "cwd.txt"), "utf8");
    expect(scratch).not.toBe(ctx.root);
    expect(existsSync(scratch)).toBe(false);
  });

  test("an unreadable fixture fails the check with the file named", async () => {
    const ctx = fixture({ ...files(server([])), "tests/fixtures/mcp/tools-list.json": "{" });
    const result = await runNamed(checks, "mcp handshake", ctx);
    expect(result.status).toBe("fail");
    expect(result.detail.startsWith("tests/fixtures/mcp/tools-list.json: ")).toBe(true);
  });
});

describe("judgeHandshake", () => {
  const expected = ["alpha", "beta"];

  test("both responses with every tool pass", () => {
    expect(judgeHandshake(run(`${answers(1)}\n${answers(2)}\n`), expected)).toMatchObject({ status: "pass" });
  });

  test("no initialize response and no tools/list response each fail", () => {
    expect(judgeHandshake(run(`${answers(2)}\n`), expected)).toEqual({ status: "fail", detail: "no initialize response" });
    expect(judgeHandshake(run(`${answers(1)}\n`), expected)).toEqual({
      status: "fail",
      detail: "no tools/list response; tools/list is missing alpha; tools/list is missing beta",
    });
  });

  test("a non-zero exit fails before the output is read", () => {
    expect(judgeHandshake(run(`${answers(1)}\n${answers(2)}`, 1, "first\nsecond"), expected)).toEqual({
      status: "fail",
      detail: "the handshake command exited 1 (first | second)",
    });
  });
});
