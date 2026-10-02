import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER = join(import.meta.dir, "..", "omca.ts");
const ROUND_TRIPS = 100;
const WARM_UP = 20;
const MEDIAN_CEILING_MS = 3;

type Server = { proc: Bun.Subprocess<"pipe", "pipe", "pipe">; project: string; hook: (args: Record<string, string>) => Promise<string> };

const running: Server[] = [];

afterEach(() => {
  for (const server of running.splice(0)) {
    server.proc.kill("SIGKILL");
    rmSync(server.project, { recursive: true, force: true });
  }
});

function startServer(trace: boolean): Server {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "omca-hook-")));
  expect(Bun.spawnSync(["git", "init", "-q", project]).exitCode).toBe(0);
  const env: Record<string, string | undefined> = { ...process.env, OMCA_SERVER_ROLE: "hooks" };
  delete env.OMCA_DISABLED_HOOKS;
  delete env.OMCA_HOOK_TRACE;
  if (trace) env.OMCA_HOOK_TRACE = "1";
  const proc = Bun.spawn([process.execPath, SERVER], { cwd: project, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let nextId = 1;

  const hook = async (args: Record<string, string>): Promise<string> => {
    const id = nextId++;
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "omca_hook", arguments: args } })}\n`);
    proc.stdin.flush();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        const reply = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        expect(reply.id).toBe(id);
        return reply.result.content[0].text;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("the server closed stdout");
      buffer += decoder.decode(value, { stream: true });
    }
  };
  const server = { proc, project, hook };
  running.push(server);
  return server;
}

const bashCall = (sessionId: string, command: string): Record<string, string> => ({
  event: "PostToolUse",
  session_id: sessionId,
  cwd: "/somewhere",
  agent_id: "",
  agent_type: "",
  tool_name: "Bash",
  tool_input: JSON.stringify({ command, description: "run it" }),
  tool_response: JSON.stringify({ stdout: "10 passed", stderr: "", interrupted: false }),
});

const NOTE =
  '{"hookSpecificOutput":{"hookEventName":"PostToolUse","classifierContext":"This Bash call ran one of this ' +
  "repository's own verification runners (test, lint, build, or typecheck).\"}}";

describe("omca_hook over stdio", () => {
  test("an entry-shaped PostToolUse call records the verification, and TaskCompleted then blocks", async () => {
    const server = startServer(true);
    const sessionId = crypto.randomUUID();
    expect(await server.hook(bashCall(sessionId, "bun test"))).toBe(NOTE);
    const status = JSON.parse(readFileSync(join(server.project, ".omca", "state", "session", `${sessionId}.json`), "utf8"));
    expect(status.verification).toMatchObject({ command: "bun test", exit_code: null, evidence_logged: false });

    const completed = JSON.parse(await server.hook({ ...bashCall(sessionId, ""), event: "TaskCompleted", tool_name: "", tool_input: "", tool_response: "" }));
    expect(completed.decision).toBe("block");
    expect(completed.reason).toStartWith("You ran `bun test` at ");

    const trace = readFileSync(join(server.project, ".omca", "state", "hook-trace.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(trace.map(({ at, ...rest }) => [typeof at === "string" && !Number.isNaN(Date.parse(at)), rest])).toEqual([
      [true, { event: "PostToolUse", session_id: sessionId, agent_id: "", agent_type: "", tool_name: "Bash", output: "context" }],
      [true, { event: "TaskCompleted", session_id: sessionId, agent_id: "", agent_type: "", tool_name: "", output: "block" }],
    ]);
  });

  test("without OMCA_HOOK_TRACE the server writes no trace", async () => {
    const server = startServer(false);
    expect(await server.hook(bashCall(crypto.randomUUID(), "ls"))).toBe("{}");
    expect(existsSync(join(server.project, ".omca", "state", "hook-trace.jsonl"))).toBe(false);
  });

  test(`${ROUND_TRIPS} warm omca_hook round trips have a median of at most ${MEDIAN_CEILING_MS} ms`, async () => {
    const server = startServer(false);
    const sessionId = crypto.randomUUID();
    for (let i = 0; i < WARM_UP; i++) await server.hook(bashCall(sessionId, "ls -la"));
    const samples: number[] = [];
    for (let i = 0; i < ROUND_TRIPS; i++) {
      const started = performance.now();
      await server.hook(bashCall(sessionId, i % 2 === 0 ? "ls -la" : "just test"));
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const median = ((samples[ROUND_TRIPS / 2 - 1] ?? 0) + (samples[ROUND_TRIPS / 2] ?? 0)) / 2;
    console.log(`omca_hook warm round trip over stdio: median ${median.toFixed(3)} ms, p95 ${samples[94]?.toFixed(3)} ms`);
    expect(median).toBeLessThanOrEqual(MEDIAN_CEILING_MS);
  });
});
