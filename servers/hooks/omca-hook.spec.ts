import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER = join(import.meta.dir, "..", "omca.ts");
const WARM_UP = 20;
const MEDIAN_CEILING_MS = 3;
const BURST_CALLS = 20;
const BURST_ROUNDS = 5;
const BURST_TIMEOUT_MS = 60_000;

type Server = {
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  project: string;
  call: (name: string, args: Record<string, unknown>) => Promise<string>;
  hook: (args: Record<string, string>) => Promise<string>;
};

const running: Server[] = [];

// A killed process keeps its working directory open on Windows until it has exited, so the directory is removed only after the exit.
afterEach(async () => {
  for (const server of running.splice(0)) {
    server.proc.kill("SIGKILL");
    await server.proc.exited;
    rmSync(server.project, { recursive: true, force: true });
  }
});

function startServer(trace: boolean): Server {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "omca-hook-")));
  expect(Bun.spawnSync(["git", "init", "-q", project], { env: process.env }).exitCode).toBe(0);
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.OMCA_DISABLED_HOOKS;
  delete env.OMCA_HOOK_TRACE;
  if (trace) env.OMCA_HOOK_TRACE = "1";
  const proc = Bun.spawn([process.execPath, SERVER], { cwd: project, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const pending = new Map<number, (text: string) => void>();
  let nextId = 1;

  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
        const reply = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        pending.get(reply.id)?.(reply.result.content[0].text);
        pending.delete(reply.id);
      }
    }
  })();

  const call = (name: string, args: Record<string, unknown>): Promise<string> =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
      proc.stdin.flush();
    });
  const server = { proc, project, call, hook: (args: Record<string, string>) => call("omca_hook", args) };
  running.push(server);
  return server;
}

const bashCall = (sessionId: string, command: string): Record<string, string> => ({
  event: "PostToolUse",
  session_id: sessionId,
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

  test("a bound plan's Stop answers with additionalContext once, then {} on the stop_hook_active retry", async () => {
    const server = startServer(true);
    const sessionId = crypto.randomUUID();
    const plan = join(server.project, "plan.md");
    writeFileSync(plan, "# Plan\n\n- [ ] 1. First task\n");
    mkdirSync(join(server.project, ".omca", "state"), { recursive: true });
    const registry = {
      plans: { demo: { active_plan: plan, started_at: "2026-01-01T00:00:00Z", session_ids: [sessionId], agent: "sisyphus" } },
      bindings: { [sessionId]: { plan_name: "demo", bound_at: Math.floor(Date.now() / 1000) } },
    };
    writeFileSync(join(server.project, ".omca", "state", "boulder.json"), JSON.stringify(registry));
    const stop = { event: "Stop", session_id: sessionId, transcript_path: "", last_assistant_message: "", background_tasks: "" };

    expect(JSON.parse(await server.hook({ ...stop, stop_hook_active: "false" }))).toEqual({
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext:
          "[PLAN CONTINUATION] The bound plan 'demo' still has 1 unchecked task (next: First task). Continue with the next task. " +
          "If its work is already done and reviewed, flip its checkbox. If it cannot proceed without the user, record why with notepad_write and " +
          "ask the user; a turn that asks the user is not blocked.",
      },
    });
    expect(await server.hook({ ...stop, stop_hook_active: "true" })).toBe("{}");

    const trace = readFileSync(join(server.project, ".omca", "state", "hook-trace.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(trace.map(({ event, output }) => [event, output])).toEqual([
      ["Stop", "continue"],
      ["Stop", "empty"],
    ]);
  });

  test("without OMCA_HOOK_TRACE the server writes no trace", async () => {
    const server = startServer(false);
    expect(await server.hook(bashCall(crypto.randomUUID(), "ls"))).toBe("{}");
    expect(existsSync(join(server.project, ".omca", "state", "hook-trace.jsonl"))).toBe(false);
  });

  // The server handles a hook and a ledger write on one thread, so a hook queued behind a write waits
  // out its fsync, which costs 0.4 ms on Linux and several ms on a macOS or Windows runner. The bound
  // is the ceiling above the median of the same run's writes made alone, not a fixed time.
  test(`omca_hook keeps a median within ${MEDIAN_CEILING_MS} ms of an evidence_log write while the same server answers a ${BURST_CALLS}-call Bash burst that logs evidence on every call`, async () => {
    const server = startServer(false);
    const sessionId = crypto.randomUUID();
    const evidence = (i: number): Record<string, unknown> => ({
      evidence_type: "test",
      command: `bun test ${i}`,
      exit_code: 0,
      output_snippet: "ok",
      working_directory: server.project,
    });
    const writes: number[] = [];
    for (let i = 0; i < WARM_UP; i++) {
      await server.hook(bashCall(sessionId, "ls -la"));
      const started = performance.now();
      await server.call("evidence_log", evidence(i));
      writes.push(performance.now() - started);
    }
    writes.sort((a, b) => a - b);
    const writeMedian = ((writes[WARM_UP / 2 - 1] ?? 0) + (writes[WARM_UP / 2] ?? 0)) / 2;
    const samples: number[] = [];
    const timed = async (args: Record<string, string>): Promise<void> => {
      const started = performance.now();
      await server.hook(args);
      samples.push(performance.now() - started);
    };
    for (let round = 0; round < BURST_ROUNDS; round++) {
      for (let i = 0; i < BURST_CALLS; i++) {
        const logged = server.call("evidence_log", evidence(round * BURST_CALLS + i));
        await timed({ ...bashCall(sessionId, i % 2 === 0 ? "ls -la" : "just test"), event: "PreToolUse" });
        await logged;
        await timed(bashCall(sessionId, "ls -la"));
      }
    }
    const ledger = JSON.parse(readFileSync(join(server.project, ".omca", "evidence", "verification-evidence.json"), "utf8"));
    expect(ledger.entries).toHaveLength(WARM_UP + BURST_ROUNDS * BURST_CALLS);
    samples.sort((a, b) => a - b);
    const median = ((samples[samples.length / 2 - 1] ?? 0) + (samples[samples.length / 2] ?? 0)) / 2;
    console.log(
      `omca_hook round trip under a ${BURST_CALLS}-call burst with an evidence_log write queued ahead of each PreToolUse (${samples.length} hook calls): median ${median.toFixed(3)} ms, p95 ${samples[Math.floor(samples.length * 0.95)]?.toFixed(3)} ms, max ${samples.at(-1)?.toFixed(3)} ms, against a write alone at median ${writeMedian.toFixed(3)} ms`,
    );
    expect(median).toBeLessThanOrEqual(writeMedian + MEDIAN_CEILING_MS);
  }, BURST_TIMEOUT_MS);
});
