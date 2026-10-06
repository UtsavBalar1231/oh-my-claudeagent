import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StopGate } from "../../src/core/stop-ledger.ts";
import { dispatch, type Output, payloadOf } from "./registry.ts";
import { findSession, touchSession } from "./session-state.ts";
import * as statusFile from "./status-file.ts";

const NOW = 1_786_000_000_000;
const NOW_S = NOW / 1000;
const SECOND = 1000;
const HOOKS = join(import.meta.dir, "..", "..", "hooks", "hooks.json");
const GATES: readonly StopGate[] = ["plan-continuation", "final-verification", "drift-guard"];
const UNFINISHED = "TODO: imple" + "ment";
const CLAIM = "All done, implemented and fixed.";

const UNCHECKED_PLAN = "# My Plan\n\n- [x] 1. First task\n- [ ] 2. Second task not done\n";
const COMPLETE_PLAN = "# My Plan\n\n## TODOs\n\n- [x] 1. First task\n- [x] 2. Second task\n- [x] 3. Third task\n";
const NO_BOXES_PLAN = "# Context Document\n\nThis is a reference doc with no tasks.\n";
const MALFORMED_PLAN = "# My Plan\n\n- [ ] Task without a number\n";

const RUNNING_SUBAGENT = [{ id: "task-001", type: "subagent", status: "running", description: "executor wave", agent_type: "oh-my-claudeagent:executor" }];
const FINISHED_SUBAGENT = [{ ...RUNNING_SUBAGENT[0], status: "completed" }];

const feedback = (additionalContext: string): Output => ({ hookSpecificOutput: { hookEventName: "Stop", additionalContext } });

const CONTINUE_TEXT =
  "[PLAN CONTINUATION] The bound plan 'test-plan' still has 1 unchecked task (next: Second task not done). Continue with the next task. " +
  "If its work is already done and reviewed, flip its checkbox. If it cannot proceed without the user, record why with notepad_write and " +
  "ask the user; a turn that asks the user is not blocked.";
const CONTINUE: Output = feedback(CONTINUE_TEXT);

const corruptRegistry = (root: string): Output =>
  feedback(
    `[PLAN CONTINUATION] ${join(root, ".omca", "state", "boulder.json")} is not valid JSON, so this session's plan state cannot be resolved and ` +
      "plan-scoped enforcement is off. Repair or delete the file, then stop again. Set " +
      "OMCA_DISABLED_HOOKS=plan-continuation to bypass.",
  );

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

const unverified = (plan: string): Output =>
  feedback(
    `[FINAL VERIFICATION] Every task in plan '${plan}' is checked, but no final_verification evidence matches its current contents. ` +
      "Record the verdict of the plan's completeness review, running the review first if it has not run: " +
      'evidence_log(evidence_type="final_verification", command="<what the review covered>", exit_code=<0 for COMPLETE, 1 for INCOMPLETE>, ' +
      `output_snippet="<verdict>", plan_sha256="${sha256(plan)}"). An INCOMPLETE verdict means fixing the gap and reviewing again. ` +
      "Set OMCA_DISABLED_HOOKS=final-verification to bypass.",
  );

const corruptLedger = (root: string): Output =>
  feedback(`[FINAL VERIFICATION] Evidence file corrupt. Repair ${join(root, ".omca", "evidence", "verification-evidence.json")} before stopping.`);

const drift = (...findings: string[]): Output =>
  feedback(
    `[DRIFT GUARD] Completion claimed but stub markers remain on added/untracked lines:\n${findings.map((line) => `${line}\n`).join("")}\n` +
      "Resolve the stubs before claiming done, or stop claiming completion. Set OMCA_DISABLED_HOOKS=drift-guard to bypass.",
  );

const roots: string[] = [];

afterEach(() => {
  delete process.env.OMCA_DISABLED_HOOKS;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const onlyGate = (gate: StopGate): void => {
  process.env.OMCA_DISABLED_HOOKS = GATES.filter((other) => other !== gate).join(",");
};

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "omca-stop-gates-"));
  roots.push(root);
  mkdirSync(join(root, ".omca", "state"), { recursive: true });
  return root;
}

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, env: process.env, stdout: "ignore", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

function repository(): string {
  const root = project();
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  return root;
}

function commitAll(root: string): void {
  git(root, "add", "-A");
  git(root, "commit", "-qm", "seed");
}

function write(root: string, file: string, content: string | Uint8Array): void {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), content);
}

const append = (root: string, file: string, content: string): void => write(root, file, readFileSync(join(root, file), "utf8") + content);

type Stop = { root: string; sessionId: string; stop: (extra?: Record<string, unknown>, now?: number) => Promise<Output> };

function session(root = project(), sessionId: string = crypto.randomUUID()): Stop {
  return {
    root,
    sessionId,
    stop: (extra = {}, now = NOW) => dispatch({ event: "Stop", session_id: sessionId, stop_hook_active: "false", ...extra }, root, now),
  };
}

function bind({ root, sessionId }: Stop, plan: string, { boundAt = NOW_S, owner = sessionId } = {}): string {
  const path = join(root, "plan.md");
  writeFileSync(path, plan);
  const registry = {
    plans: { "test-plan": { active_plan: path, started_at: "2026-01-01T00:00:00Z", session_ids: [owner] } },
    bindings: { [owner]: { plan_name: "test-plan", bound_at: boundAt } },
  };
  writeFileSync(join(root, ".omca", "state", "boulder.json"), JSON.stringify(registry));
  return path;
}

const writeRegistry = (root: string, content: string): void => writeFileSync(join(root, ".omca", "state", "boulder.json"), content);

function writeLedger(root: string, entries: readonly Record<string, unknown>[] | string): void {
  mkdirSync(join(root, ".omca", "evidence"), { recursive: true });
  writeFileSync(join(root, ".omca", "evidence", "verification-evidence.json"), typeof entries === "string" ? entries : JSON.stringify({ entries }));
}

const verdict = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "final_verification",
  command: "executor: COMPLETE",
  exit_code: 0,
  output_snippet: "COMPLETE",
  timestamp: "2026-10-02T12:00:00Z",
  ...fields,
});

function transcript(root: string, ...records: object[]): string {
  const path = join(root, "transcript.jsonl");
  writeFileSync(path, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
  return path;
}

const user = (content: unknown) => ({ type: "user", message: { role: "user", content } });
const assistant = (content: unknown) => ({ type: "assistant", message: { role: "assistant", content } });
const said = (text: string) => assistant([{ type: "text", text }]);

const ASKED = [
  user("work through the plan"),
  said("Task 2 forks two ways."),
  assistant([{ type: "tool_use", name: "AskUserQuestion", input: {} }]),
  user([{ type: "tool_result", content: "recursive descent" }]),
];

async function stops(run: Stop, times: number, extra: Record<string, unknown> = {}): Promise<Output[]> {
  const answers: Output[] = [];
  for (let i = 0; i < times; i++) answers.push(await run.stop(extra));
  return answers;
}

const quietErrors = () => spyOn(console, "error").mockImplementation(() => {});

describe("plan continuation", () => {
  beforeEach(() => onlyGate("plan-continuation"));

  test("plan continuation: unchecked plan blocks Stop with next-task text", async () => {
    const run = session();
    bind(run, UNCHECKED_PLAN);
    expect(await run.stop()).toEqual(CONTINUE);
    const state = findSession(run.sessionId);
    expect(state?.planBackoff).toEqual({ plan: "test-plan", backoff: { consecutiveBlocks: 1, lastBlockAt: NOW_S, lastUnchecked: 1, sameCountRun: 1, isStagnated: false } });
    expect([...(state?.stopBlocks ?? [])]).toEqual([["plan-continuation", 1]]);
  });

  test("plan continuation: a fenced example task is not quoted as the next task", async () => {
    const run = session();
    bind(run, "# Plan\n\n```md\n- [ ] 1. Example in a fence\n```\n\n- [x] 1. First task done\n- [ ] 2. Second task not done\n");
    expect(await run.stop()).toEqual(CONTINUE);
  });

  test("plan continuation: the next task label is capped at 80 code points", async () => {
    const run = session();
    bind(run, `- [ ] 1. ${"y".repeat(100)}\n`);
    const output = await run.stop();
    expect(JSON.stringify(output)).toContain(`(next: ${"y".repeat(79)}…)`);
  });

  test("plan continuation: fully-checked plan allows Stop", async () => {
    const run = session();
    bind(run, COMPLETE_PLAN);
    expect(await run.stop()).toEqual({});
  });

  test("plan continuation: no bound plan allows Stop", async () => {
    expect(await session().stop()).toEqual({});
  });

  test("plan continuation: registered incomplete plan with no binding for this session allows Stop", async () => {
    const run = session();
    bind(run, UNCHECKED_PLAN, { owner: "other-session" });
    expect(await run.stop()).toEqual({});
  });

  test("plan continuation: stop_hook_active allows Stop and leaves the counters untouched", async () => {
    const run = session();
    bind(run, UNCHECKED_PLAN);
    expect(await run.stop({ stop_hook_active: "true" })).toEqual({});
    expect(findSession(run.sessionId)?.planBackoff).toBeUndefined();
    expect(findSession(run.sessionId)?.stopBlocks).toBeUndefined();
  });

  test("plan continuation: OMCA_DISABLED_HOOKS=plan-continuation allows Stop", async () => {
    const run = session();
    bind(run, UNCHECKED_PLAN);
    process.env.OMCA_DISABLED_HOOKS = "final-verification,drift-guard,plan-continuation";
    expect(await run.stop()).toEqual({});
  });

  test("plan continuation: cooldown suppresses a second rapid invocation", async () => {
    const run = session();
    bind(run, UNCHECKED_PLAN);
    expect(await run.stop()).toEqual(CONTINUE);
    expect(await run.stop({}, NOW + 9 * SECOND)).toEqual({});
    expect(await run.stop({}, NOW + 10 * SECOND)).toEqual(CONTINUE);
    expect(findSession(run.sessionId)?.planBackoff).toEqual({ plan: "test-plan", backoff: { consecutiveBlocks: 2, lastBlockAt: NOW_S + 10, lastUnchecked: 1, sameCountRun: 2, isStagnated: false } });
  });

  test("plan continuation: stagnation escape frees the 4th identical-count invocation", async () => {
    const run = session();
    bind(run, UNCHECKED_PLAN);
    for (const at of [0, 100, 200]) expect(await run.stop({}, NOW + at * SECOND)).toEqual(CONTINUE);
    expect(await run.stop({}, NOW + 300 * SECOND)).toEqual({});
    expect(findSession(run.sessionId)?.planBackoff).toEqual({ plan: "test-plan", backoff: { consecutiveBlocks: 3, lastBlockAt: NOW_S + 200, lastUnchecked: 1, sameCountRun: 3, isStagnated: true } });
    expect(await run.stop({}, NOW + 10_000 * SECOND)).toEqual({});
  });

  test("plan continuation: user-pause intent in the transcript allows Stop", async () => {
    const run = session();
    bind(run, UNCHECKED_PLAN);
    const path = transcript(run.root, user("start on task 2"), said("Working on it."), user("let's pause here for now"));
    expect(await run.stop({ transcript_path: path })).toEqual({});
  });

  test.each(["keep going", "do task 2 later", "pause the music in the demo, then continue"])(
    "plan continuation: a last prompt that is not a pause request (%p) still blocks",
    async (prompt) => {
      const run = session();
      bind(run, UNCHECKED_PLAN);
      const path = transcript(run.root, user("start on task 2"), said("Working on it."), user(prompt));
      expect(await run.stop({ transcript_path: path })).toEqual(CONTINUE);
    },
  );

  test.each(["later", "ok, stop here.", "Great work. Let's continue tomorrow", "can we take a break?"])(
    "plan continuation: a last prompt that asks to pause (%p) allows Stop",
    async (prompt) => {
      const run = session();
      bind(run, UNCHECKED_PLAN);
      const path = transcript(run.root, user("start on task 2"), said("Working on it."), user(prompt));
      expect(await run.stop({ transcript_path: path })).toEqual({});
    },
  );

  test("plan continuation: only the transcript's last 2 MiB is read, and a prompt before it counts for nothing", async () => {
    const run = session();
    bind(run, UNCHECKED_PLAN);
    const filler = said("x".repeat(1024));
    const path = transcript(run.root, user("lets pause here"), ...Array.from({ length: 2100 }, () => filler));
    expect(await run.stop({ transcript_path: path })).toEqual(CONTINUE);
    const tail = transcript(run.root, ...Array.from({ length: 2100 }, () => filler), user("lets pause here"));
    expect(await run.stop({ transcript_path: tail }, NOW + 10 * SECOND)).toEqual({});
  });

  test("plan continuation: the scan reads past a tool_result-only user entry to the pause prompt", async () => {
    const run = session();
    bind(run, UNCHECKED_PLAN);
    const path = transcript(
      run.root,
      user("start on task 2"),
      said("Working on it."),
      user("lets pause here for now."),
      assistant([{ type: "tool_use", name: "Read", input: {} }]),
      user([{ type: "tool_result", content: "file contents" }]),
    );
    expect(await run.stop({ transcript_path: path })).toEqual({});
  });

  test("plan continuation: malformed lines after the pause prompt are skipped, not read as a prompt", async () => {
    const run = session();
    bind(run, UNCHECKED_PLAN);
    const path = transcript(run.root, user("start on task 2"), said("Working on it."), user("lets pause here for now."));
    writeFileSync(path, `${readFileSync(path, "utf8")}{not json\n\n[1, 2]\n"text"\n`);
    expect(await run.stop({ transcript_path: path })).toEqual({});
  });

  test("plan continuation: an AskUserQuestion call in this turn allows Stop", async () => {
    const run = session();
    bind(run, UNCHECKED_PLAN);
    expect(await run.stop({ transcript_path: transcript(run.root, ...ASKED), last_assistant_message: "Task 2 forks two ways." })).toEqual({});
  });

  test("plan continuation: an AskUserQuestion call before a later user prompt still blocks", async () => {
    const run = session();
    bind(run, UNCHECKED_PLAN);
    const path = transcript(run.root, ...ASKED, user("go with recursive descent"), said("Understood."));
    expect(await run.stop({ transcript_path: path, last_assistant_message: "Understood." })).toEqual(CONTINUE);
  });

  test("plan continuation: an unreadable transcript record after the call yields no escape", async () => {
    const run = session();
    bind(run, UNCHECKED_PLAN);
    const path = transcript(run.root, ...ASKED);
    writeFileSync(path, `${readFileSync(path, "utf8")}{not json\n`);
    expect(await run.stop({ transcript_path: path, last_assistant_message: "Task 2 forks two ways." })).toEqual(CONTINUE);
  });

  test("plan continuation: no marker and no AskUserQuestion call blocks", async () => {
    const run = session();
    bind(run, UNCHECKED_PLAN);
    const path = transcript(
      run.root,
      user("work through the plan"),
      assistant([{ type: "tool_use", name: "Read", input: {} }]),
      user([{ type: "tool_result", content: "file body" }]),
    );
    expect(await run.stop({ transcript_path: path, last_assistant_message: "Read the file, moving on." })).toEqual(CONTINUE);
  });

  test("plan continuation: a prose question with no marker and no tool call blocks", async () => {
    const run = session();
    bind(run, UNCHECKED_PLAN);
    const question = "Which parser should task 2 use, recursive descent or generated?";
    const path = transcript(run.root, user("work through the plan"), said(question));
    expect(await run.stop({ transcript_path: path, last_assistant_message: question })).toEqual(CONTINUE);
  });

  test("plan continuation: a declared BLOCKING QUESTIONS block allows Stop", async () => {
    const run = session();
    bind(run, UNCHECKED_PLAN);
    const message = "Task 2 needs a decision.\n\n## BLOCKING QUESTIONS\n\nQ1. Which parser?\nA) recursive descent\nB) generated\nRecommended: A";
    expect(await run.stop({ last_assistant_message: message })).toEqual({});
  });

  test("plan continuation: the BLOCKING QUESTIONS heading is read from the transcript when the payload has no message", async () => {
    const run = session();
    bind(run, UNCHECKED_PLAN);
    const path = transcript(run.root, user("go"), said("Stuck.\n### BLOCKING QUESTIONS\nQ1. Which?"));
    expect(await run.stop({ transcript_path: path })).toEqual({});
  });

  test("plan continuation: a trailing question mark is not an escape and still blocks", async () => {
    const run = session();
    bind(run, UNCHECKED_PLAN);
    expect(await run.stop({ last_assistant_message: "Should I refactor the parser first?" })).toEqual(CONTINUE);
  });

  test("plan continuation: a compaction in the last minute allows Stop", async () => {
    const run = session();
    bind(run, UNCHECKED_PLAN);
    const compact = (at: number) => dispatch({ event: "SessionStart", session_id: run.sessionId, cwd: run.root, source: "compact" }, run.root, at);
    await compact(NOW - 59 * SECOND);
    expect(await run.stop()).toEqual({});
    await compact(NOW - 60 * SECOND);
    expect(await run.stop()).toEqual(CONTINUE);
  });

  test("plan continuation: a binding over a day old with no evidence logged since allows Stop", async () => {
    const run = session();
    const boundAt = NOW_S - 86_401;
    bind(run, UNCHECKED_PLAN, { boundAt });
    expect(await run.stop()).toEqual({});
    writeLedger(run.root, [verdict()]);
    utimesSync(join(run.root, ".omca", "evidence", "verification-evidence.json"), boundAt + 1, boundAt + 1);
    expect(await run.stop()).toEqual(CONTINUE);
  });

  test("plan continuation: a boulder.json of another version reads as an empty registry and allows Stop", async () => {
    const run = session();
    writeRegistry(run.root, '{"version":2,"plans":{},"bindings":{}}');
    expect(await run.stop()).toEqual({});
  });

  test("plan continuation: unparseable boulder.json blocks instead of reading as no plan", async () => {
    const run = session();
    writeRegistry(run.root, "NOT JSON {");
    expect(await run.stop()).toEqual(corruptRegistry(run.root));
  });

  test.each(["null", "[]", "false", "0", '"x"'])("plan continuation: a boulder.json holding %s parses, so it reads as an empty registry and allows Stop", async (text) => {
    const run = session();
    writeRegistry(run.root, text);
    expect(await run.stop()).toEqual({});
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("plan continuation: a boulder.json that cannot be read blocks and names the error code (skipped on Windows and as root: chmod 000 does not refuse there)", async () => {
    const run = session();
    bind(run, UNCHECKED_PLAN);
    const path = join(run.root, ".omca", "state", "boulder.json");
    chmodSync(path, 0o000);
    try {
      expect(await run.stop()).toEqual(
        feedback(
          `[PLAN CONTINUATION] ${path} cannot be read (EACCES), so this session's plan state cannot be resolved and ` +
            "plan-scoped enforcement is off. Repair or delete the file, then stop again. Set " +
            "OMCA_DISABLED_HOOKS=plan-continuation to bypass.",
        ),
      );
    } finally {
      chmodSync(path, 0o644);
    }
  });

  test("plan continuation: a plan that stagnated does not hold back the next plan the session binds", async () => {
    const run = session();
    bind(run, UNCHECKED_PLAN);
    for (const at of [0, 100, 200]) expect(await run.stop({}, NOW + at * SECOND)).toEqual(CONTINUE);
    expect(await run.stop({}, NOW + 300 * SECOND)).toEqual({});
    const other = join(run.root, "other.md");
    writeFileSync(other, UNCHECKED_PLAN);
    writeRegistry(
      run.root,
      JSON.stringify({
        plans: { "plan-b": { active_plan: other, started_at: "2026-01-01T00:00:00Z", session_ids: [run.sessionId] } },
        bindings: { [run.sessionId]: { plan_name: "plan-b", bound_at: NOW_S } },
      }),
    );
    expect(await run.stop({}, NOW + 301 * SECOND)).toEqual(feedback(CONTINUE_TEXT.replace("'test-plan'", "'plan-b'")));
    expect(findSession(run.sessionId)?.planBackoff?.plan).toBe("plan-b");
  });

  test("plan continuation: a plan with every task checked refunds the budget and clears the backoff", async () => {
    const run = session();
    const path = bind(run, UNCHECKED_PLAN);
    expect(await run.stop()).toEqual(CONTINUE);
    writeFileSync(path, COMPLETE_PLAN);
    expect(await run.stop({}, NOW + 10 * SECOND)).toEqual({});
    expect(findSession(run.sessionId)?.planBackoff).toBeUndefined();
    expect(findSession(run.sessionId)?.stopBlocks?.has("plan-continuation") ?? false).toBe(false);
  });

  test("plan continuation: a session whose blocks cannot be recorded never blocks", async () => {
    const errors = quietErrors();
    try {
      const run = session(project(), "../escape");
      bind(run, UNCHECKED_PLAN);
      expect(await stops(run, 10)).toEqual(Array(10).fill({}));
    } finally {
      errors.mockRestore();
    }
  });

  test("plan continuation: a corrupt boulder.json stops blocking once the Stop-block cap is hit", async () => {
    const run = session();
    writeRegistry(run.root, "NOT JSON {");
    const block = corruptRegistry(run.root);
    expect(await stops(run, 7)).toEqual([block, block, block, block, block, {}, {}]);
  });
});

describe("plan continuation and background work", () => {
  beforeEach(() => onlyGate("plan-continuation"));

  test("plan continuation: blocks when tasks remain and nothing is running", async () => {
    const run = session();
    bind(run, UNCHECKED_PLAN);
    expect(await run.stop({ background_tasks: [] })).toEqual(CONTINUE);
  });

  test("plan continuation: opens when a background task is running", async () => {
    const run = session();
    bind(run, UNCHECKED_PLAN);
    const payload = payloadOf({ event: "Stop", session_id: run.sessionId, stop_hook_active: "false", background_tasks: JSON.stringify(RUNNING_SUBAGENT) });
    expect(await dispatch(payload, run.root, NOW)).toEqual({});
    expect(findSession(run.sessionId)?.planBackoff).toBeUndefined();
  });

  test("plan continuation: a running background shell, such as a dev server, still blocks", async () => {
    const run = session();
    bind(run, UNCHECKED_PLAN);
    const shell = [{ id: "task-002", type: "shell", status: "running", description: "bun run dev" }];
    expect(await run.stop({ background_tasks: shell })).toEqual(CONTINUE);
    expect(await run.stop({ background_tasks: [...shell, ...RUNNING_SUBAGENT] }, NOW + 10 * SECOND)).toEqual({});
  });

  test("plan continuation: a finished background task still blocks", async () => {
    const run = session();
    bind(run, UNCHECKED_PLAN);
    expect(await run.stop({ background_tasks: FINISHED_SUBAGENT })).toEqual(CONTINUE);
  });

  test("plan continuation: the open path clears this gate's ledger key only", async () => {
    const run = session();
    bind(run, UNCHECKED_PLAN);
    touchSession(run.sessionId).stopBlocks = new Map([
      ["plan-continuation", 3],
      ["drift-guard", 2],
    ]);
    expect(await run.stop({ background_tasks: RUNNING_SUBAGENT })).toEqual({});
    expect([...(findSession(run.sessionId)?.stopBlocks ?? [])]).toEqual([["drift-guard", 2]]);
  });

  test("drift-guard: still blocks a completion claim while a task is running", async () => {
    const run = session(repository());
    write(run.root, "a.js", "seed\n");
    commitAll(run.root);
    append(run.root, "a.js", "it.only('t', () => {})\n");
    onlyGate("drift-guard");
    expect(await run.stop({ last_assistant_message: CLAIM, background_tasks: RUNNING_SUBAGENT })).toEqual(drift("a.js:2  it.only('t', () => {})"));
  });
});

describe("final verification", () => {
  beforeEach(() => onlyGate("final-verification"));

  test("final verification: no active plan allows Stop", async () => {
    expect(await session().stop()).toEqual({});
  });

  test("final verification: incomplete checkboxes pass through", async () => {
    const run = session();
    bind(run, UNCHECKED_PLAN);
    expect(await run.stop()).toEqual({});
  });

  test("final verification: complete plan with no evidence blocks Stop", async () => {
    const run = session();
    const plan = bind(run, COMPLETE_PLAN, { boundAt: 1 });
    expect(await run.stop()).toEqual(unverified(plan));
    expect([...(findSession(run.sessionId)?.stopBlocks ?? [])]).toEqual([["final-verification", 1]]);
  });

  test("final verification: registered complete plan bound to another session allows Stop", async () => {
    const run = session();
    bind(run, COMPLETE_PLAN, { owner: "other-session" });
    expect(await run.stop()).toEqual({});
  });

  test("final verification: complete plan with final_verification evidence allows Stop", async () => {
    const run = session();
    bind(run, COMPLETE_PLAN);
    writeLedger(run.root, [verdict()]);
    expect(await run.stop()).toEqual({});
  });

  test("final verification: stop_hook_active guard allows Stop", async () => {
    const run = session();
    bind(run, COMPLETE_PLAN);
    expect(await run.stop({ stop_hook_active: "true" })).toEqual({});
  });

  test("final verification: plan with no checkboxes allows Stop", async () => {
    const run = session();
    bind(run, NO_BOXES_PLAN);
    expect(await run.stop()).toEqual({});
  });

  test("final verification: final_verification with exit_code=1 does not open gate", async () => {
    const run = session();
    const plan = bind(run, COMPLETE_PLAN);
    writeLedger(run.root, [verdict({ exit_code: 1 })]);
    expect(await run.stop()).toEqual(unverified(plan));
  });

  test("final verification: boulder with missing plan file allows Stop", async () => {
    const run = session();
    writeRegistry(run.root, JSON.stringify({ active_plan: "/nonexistent/plan.md" }));
    expect(await run.stop()).toEqual({});
    bind(run, COMPLETE_PLAN);
    rmSync(join(run.root, "plan.md"));
    expect(await run.stop()).toEqual({});
  });

  test.each([
    ["a ledger of another version", '{"version":2,"entries":[]}'],
    ["a ledger with no entries list", "{}"],
    ["a ledger that is not an object", "[]"],
  ])("final verification: %s triggers the corruption guard", async (_label, text) => {
    const run = session();
    bind(run, COMPLETE_PLAN);
    writeLedger(run.root, text);
    expect(await run.stop()).toEqual(corruptLedger(run.root));
  });

  test("final verification: a malformed entry beside a passing verdict does not hide the verdict", async () => {
    const run = session();
    bind(run, COMPLETE_PLAN);
    writeLedger(run.root, [{ type: "test" }, verdict()]);
    expect(await run.stop()).toEqual({});
  });

  test("final verification: a ledger stamped version 1 is read like one without a version", async () => {
    const run = session();
    bind(run, COMPLETE_PLAN);
    writeLedger(run.root, JSON.stringify({ version: 1, entries: [verdict()] }));
    expect(await run.stop()).toEqual({});
  });

  test("final verification: corrupt evidence file triggers corruption guard", async () => {
    const run = session();
    bind(run, COMPLETE_PLAN);
    writeLedger(run.root, "THIS IS NOT JSON {");
    expect(await run.stop()).toEqual(corruptLedger(run.root));
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("final verification: an evidence file that cannot be read is named with its error code, not called corrupt (skipped on Windows and as root: chmod 000 does not refuse there)", async () => {
    const run = session();
    bind(run, COMPLETE_PLAN);
    writeLedger(run.root, [verdict()]);
    const path = join(run.root, ".omca", "evidence", "verification-evidence.json");
    chmodSync(path, 0o000);
    try {
      expect(await run.stop()).toEqual(feedback(`[FINAL VERIFICATION] Evidence file unreadable (EACCES). Fix ${path} before stopping.`));
    } finally {
      chmodSync(path, 0o644);
    }
  });

  test("final verification: an evidence file without an entries array is corrupt", async () => {
    const run = session();
    bind(run, COMPLETE_PLAN);
    writeLedger(run.root, '{"entries":{}}');
    expect(await run.stop()).toEqual(corruptLedger(run.root));
  });

  test("final verification: non-final evidence types do not open gate", async () => {
    const run = session();
    const plan = bind(run, COMPLETE_PLAN);
    writeLedger(run.root, [verdict({ type: "build", command: "just build" }), verdict({ type: "test", command: "just test" })]);
    expect(await run.stop()).toEqual(unverified(plan));
  });

  test("final verification: matching plan_sha256 entry allows Stop", async () => {
    const run = session();
    const plan = bind(run, COMPLETE_PLAN);
    writeLedger(run.root, [verdict({ plan_sha256: sha256(plan) })]);
    expect(await run.stop()).toEqual({});
  });

  test("final verification: mismatched plan_sha256 entry blocks Stop", async () => {
    const run = session();
    const plan = bind(run, COMPLETE_PLAN);
    writeLedger(run.root, [verdict({ plan_sha256: "0".repeat(64) })]);
    expect(await run.stop()).toEqual(unverified(plan));
  });

  test("final verification: unbound session with no registry allows Stop", async () => {
    expect(await session().stop()).toEqual({});
  });

  test("final verification: unparseable boulder.json says the gate is off instead of going quiet", async () => {
    const errors = quietErrors();
    try {
      const run = session();
      writeRegistry(run.root, "NOT JSON {");
      expect(await run.stop()).toEqual({});
      expect(errors.mock.calls).toEqual([
        [`omca: final-verification: ${join(run.root, ".omca", "state", "boulder.json")} is not valid JSON, so no plan resolves and this gate is not enforcing. Repair or delete the file.`],
      ]);
    } finally {
      errors.mockRestore();
    }
  });

  test("final verification: numbered-complete plan with a malformed unnumbered box still allows Stop", async () => {
    const run = session();
    bind(run, "# My Plan\n\n- [x] 1. First task\n- [x] 2. Second task\n- [ ] Task 3: malformed, no number-dot\n");
    writeLedger(run.root, [verdict()]);
    expect(await run.stop()).toEqual({});
  });

  test("final verification: OMCA_DISABLED_HOOKS listing this hook bypasses the gate", async () => {
    const run = session();
    bind(run, COMPLETE_PLAN);
    process.env.OMCA_DISABLED_HOOKS = "plan-continuation,drift-guard,final-verification";
    expect(await run.stop()).toEqual({});
  });

  test("final verification: OMCA_DISABLED_HOOKS listing a different hook does not bypass the gate", async () => {
    const run = session();
    const plan = bind(run, COMPLETE_PLAN);
    process.env.OMCA_DISABLED_HOOKS = "plan-continuation,drift-guard,other-hook";
    expect(await run.stop()).toEqual(unverified(plan));
  });

  test("final verification: a missing verdict stops blocking once the Stop-block cap is hit", async () => {
    const run = session();
    const block = unverified(bind(run, COMPLETE_PLAN));
    expect(await stops(run, 7)).toEqual([block, block, block, block, block, {}, {}]);
  });

  test("final verification: a corrupt evidence file stops blocking once the cap is hit", async () => {
    const run = session();
    bind(run, COMPLETE_PLAN);
    writeLedger(run.root, "THIS IS NOT JSON {");
    const block = corruptLedger(run.root);
    expect(await stops(run, 7)).toEqual([block, block, block, block, block, {}, {}]);
  });

  test("final verification: logging the verdict restores the Stop-block budget", async () => {
    const run = session();
    const block = unverified(bind(run, COMPLETE_PLAN));
    expect(await stops(run, 3)).toEqual([block, block, block]);
    expect(findSession(run.sessionId)?.stopBlocks?.get("final-verification")).toBe(3);
    writeLedger(run.root, [verdict()]);
    expect(await run.stop()).toEqual({});
    expect(findSession(run.sessionId)?.stopBlocks?.has("final-verification")).toBe(false);
  });
});

describe("drift-guard", () => {
  beforeEach(() => onlyGate("drift-guard"));

  function seeded(file = "a.txt", content = "hello\n"): Stop {
    const run = session(repository());
    write(run.root, file, content);
    commitAll(run.root);
    return run;
  }

  const claim = (run: Stop, message = "Done."): Promise<Output> => run.stop({ last_assistant_message: message });

  test("drift-guard: clean repo with completion claim allows Stop", async () => {
    expect(await claim(seeded(), CLAIM)).toEqual({});
  });

  test("drift-guard: .only marker on an added line blocks Stop", async () => {
    const run = seeded("a.js");
    append(run.root, "a.js", "it.only('t', () => {})\n");
    expect(await claim(run, "Done, all tests pass.")).toEqual(drift("a.js:2  it.only('t', () => {})"));
  });

  test("drift-guard: marker on a pre-existing unchanged line allows Stop", async () => {
    const run = seeded("preexist.js", "line1\nit.only('x')\nline3\n");
    append(run.root, "preexist.js", "unrelated new line\n");
    expect(await claim(run, "Implemented and fixed.")).toEqual({});
  });

  test("drift-guard: untracked new stub file blocks Stop", async () => {
    const run = seeded();
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    expect(await claim(run)).toEqual(drift(`new.sh:1  ${UNFINISHED}`));
  });

  test("drift-guard: untracked binary file does not crash and is not a false block", async () => {
    const run = seeded();
    write(run.root, "bin.dat", new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, ...new TextEncoder().encode(UNFINISHED)]));
    expect(await claim(run)).toEqual({});
  });

  test("drift-guard: an untracked file over 1 MiB is not scanned, and one at the limit is", async () => {
    const run = seeded();
    write(run.root, "huge.log", `${UNFINISHED}\n${"x".repeat(1024 * 1024)}`);
    expect(await claim(run)).toEqual({});
    write(run.root, "limit.log", `${UNFINISHED}\n${"x".repeat(1024 * 1024 - UNFINISHED.length - 1)}`);
    expect(await claim(run)).toEqual(drift(`limit.log:1  ${UNFINISHED}`));
  });

  test("drift-guard: non-git directory fails open (allows Stop)", async () => {
    const run = session();
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    expect(await claim(run)).toEqual({});
  });

  test("drift-guard: repo with no commits (no HEAD) fails open (allows Stop)", async () => {
    const run = session(repository());
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    expect(await claim(run)).toEqual({});
  });

  test("drift-guard: OMCA_DISABLED_HOOKS listing this hook allows Stop", async () => {
    const run = seeded();
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    process.env.OMCA_DISABLED_HOOKS = "plan-continuation,final-verification,drift-guard";
    expect(await claim(run)).toEqual({});
  });

  test("drift-guard: OMCA_DISABLED_HOOKS listing a different hook still blocks", async () => {
    const run = seeded();
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    process.env.OMCA_DISABLED_HOOKS = "plan-continuation,final-verification,other-hook";
    expect(await claim(run)).toEqual(drift(`new.sh:1  ${UNFINISHED}`));
  });

  test("drift-guard: assistant text extracted from transcript_path when last_assistant_message is absent", async () => {
    const run = seeded();
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    const path = transcript(run.root, user("go"), said("Done, all fixed."), { type: "last-prompt", lastPrompt: "x" });
    expect(await run.stop({ transcript_path: path })).toEqual(drift(`new.sh:1  ${UNFINISHED}`));
  });

  test("drift-guard: a malformed line after the claim does not hide the claim read from the transcript", async () => {
    const run = seeded();
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    const path = transcript(run.root, user("go"), said("Done, all fixed."));
    writeFileSync(path, `${readFileSync(path, "utf8")}{not json\n`);
    expect(await run.stop({ transcript_path: path })).toEqual(drift(`new.sh:1  ${UNFINISHED}`));
  });

  test("drift-guard: no assistant text anywhere allows Stop", async () => {
    const run = seeded();
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    expect(await run.stop({ transcript_path: transcript(run.root, user("go")) })).toEqual({});
  });

  test("drift-guard: a quoted 'done' is not a completion claim", async () => {
    const run = seeded();
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    expect(await claim(run, 'You asked whether the parser is "done" — the answer is no.')).toEqual({});
  });

  test("drift-guard: an unquoted claim in the same shape still blocks", async () => {
    const run = seeded();
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    expect(await claim(run, "The parser is done and the answer is yes.")).toEqual(drift(`new.sh:1  ${UNFINISHED}`));
  });

  test("drift-guard: a negator earlier in the same sentence suppresses the claim", async () => {
    const run = seeded();
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    expect(await claim(run, "The suite is not green, so the parser path is fixed nowhere yet.")).toEqual({});
  });

  test("drift-guard: a negator in a previous sentence does not suppress a later claim", async () => {
    const run = seeded();
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    expect(await claim(run, "Earlier the suite was not green. The parser is fixed now.")).toEqual(drift(`new.sh:1  ${UNFINISHED}`));
  });

  test("drift-guard: negated completion claim (not done) allows Stop despite a stub", async () => {
    const run = seeded();
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    expect(await claim(run, "This is not done yet.")).toEqual({});
  });

  test("drift-guard: a marker inside a bats test name is not a finding", async () => {
    const run = seeded();
    write(run.root, "suite.bats", `@test "guard: ${UNFINISHED} is reported" {\n\ttrue\n}\n`);
    expect(await claim(run)).toEqual({});
  });

  test("drift-guard: a marker in a bats test body is still a finding", async () => {
    const run = seeded();
    write(run.root, "suite.bats", `@test "guard: something" {\n\t# ${UNFINISHED}\n}\n`);
    expect(await claim(run)).toEqual(drift(`suite.bats:2  # ${UNFINISHED}`));
  });

  test("drift-guard: a marker in unfenced Markdown prose is not a finding", async () => {
    const run = seeded();
    write(run.root, "doc.md", `Still to do: ${UNFINISHED} the pagination path.\n`);
    expect(await claim(run)).toEqual({});
  });

  test("drift-guard: every prose extension is skipped", async () => {
    const run = seeded();
    for (const extension of ["md", "markdown", "rst", "txt", "adoc"]) write(run.root, `notes.${extension}`, `${UNFINISHED} the parser\n`);
    expect(await claim(run)).toEqual({});
  });

  test("drift-guard: the prose carve-out does not leak to code files", async () => {
    const run = seeded();
    write(run.root, "script.sh", `# ${UNFINISHED} pagination\n`);
    expect(await claim(run)).toEqual(drift(`script.sh:1  # ${UNFINISHED} pagination`));
  });

  test("drift-guard: a marker as a shell string constant is not a finding", async () => {
    const run = seeded();
    write(run.root, "guard.sh", `MARKER_TODO='${UNFINISHED}'\n`);
    expect(await claim(run)).toEqual({});
  });

  test("drift-guard: a marker in a Python list literal outside tests/ is not a finding", async () => {
    const run = seeded();
    write(run.root, "lint_rules.py", `BANNED = ["${UNFINISHED}"]\n`);
    expect(await claim(run)).toEqual({});
  });

  test("drift-guard: an unquoted marker comment in the same file is still a finding", async () => {
    const run = seeded();
    write(run.root, "guard.sh", `MARKER_TODO='${UNFINISHED}'\n# ${UNFINISHED} the parser\n`);
    expect(await claim(run)).toEqual(drift(`guard.sh:2  # ${UNFINISHED} the parser`));
  });

  test("drift-guard: a not-implemented throw is still a finding despite its quotes", async () => {
    const run = seeded();
    const stub = 'function f() { throw new Error("not imple' + 'mented yet"); }';
    write(run.root, "impl.js", `${stub}\n`);
    expect(await claim(run)).toEqual(drift(`impl.js:1  ${stub}`));
  });

  test("drift-guard: an ORM .only() projection is not a finding", async () => {
    const run = seeded();
    write(run.root, "orm.py", "qs = Model.objects.only('id')\nrow = User.select().only(User.id)\n");
    expect(await claim(run)).toEqual({});
  });

  test("drift-guard: a focused test .only is still a finding", async () => {
    const run = seeded();
    write(run.root, "spec.js", "describe.only('suite', () => {})\n");
    expect(await claim(run)).toEqual(drift("spec.js:1  describe.only('suite', () => {})"));
  });

  test("drift-guard: an unresolved stub stops blocking once the Stop-block cap is hit", async () => {
    const run = seeded();
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    const block = drift(`new.sh:1  ${UNFINISHED}`);
    expect(await stops(run, 7, { last_assistant_message: "Done." })).toEqual([block, block, block, block, block, {}, {}]);
  });

  test("drift-guard: resolving the stub restores the Stop-block budget", async () => {
    const run = seeded();
    write(run.root, "new.sh", `${UNFINISHED}\n`);
    expect((await stops(run, 6, { last_assistant_message: "Done." })).at(-1)).toEqual({});
    write(run.root, "new.sh", "resolved\n");
    expect(await claim(run)).toEqual({});
    expect(findSession(run.sessionId)?.stopBlocks?.has("drift-guard")).toBe(false);
    write(run.root, "another.sh", `${UNFINISHED}\n`);
    expect(await claim(run)).toEqual(drift(`another.sh:1  ${UNFINISHED}`));
  });

  test("drift-guard: a tree above the changed-file ceiling skips the scan", async () => {
    const run = session(repository());
    for (let i = 1; i <= 520; i++) write(run.root, `src/f${i}.sh`, "line\n");
    commitAll(run.root);
    for (let i = 1; i <= 520; i++) append(run.root, `src/f${i}.sh`, `${UNFINISHED}\n`);
    const errors = quietErrors();
    try {
      expect(await claim(run)).toEqual({});
      expect(errors.mock.calls).toEqual([["omca: drift-guard: 520 changed files exceeds the 500-file scan ceiling, so the stub scan is skipped this Stop."]]);
    } finally {
      errors.mockRestore();
    }
  });

  test("drift-guard: a tree just under the ceiling still scans and blocks", async () => {
    const run = session(repository());
    for (let i = 1; i <= 40; i++) write(run.root, `src/f${i}.sh`, "line\n");
    commitAll(run.root);
    append(run.root, "src/f7.sh", `${UNFINISHED}\n`);
    expect(await claim(run)).toEqual(drift(`src/f7.sh:2  ${UNFINISHED}`));
  });

  test("drift-guard: a marker in a file whose name contains a space is reported", async () => {
    const run = seeded();
    write(run.root, "my file.js", "it.only('t', () => {})\n");
    git(run.root, "add", "-A");
    expect(await claim(run, "Done, all tests pass.")).toEqual(drift("my file.js:1  it.only('t', () => {})"));
  });

  test("drift-guard: diff.mnemonicPrefix does not mangle the reported path", async () => {
    const run = seeded();
    git(run.root, "config", "diff.mnemonicPrefix", "true");
    write(run.root, "pager.sh", `# ${UNFINISHED} pagination\n`);
    git(run.root, "add", "-A");
    expect(await claim(run)).toEqual(drift(`pager.sh:1  # ${UNFINISHED} pagination`));
  });

  test("drift-guard: core.quotePath does not mangle a non-ASCII path", async () => {
    const run = seeded();
    git(run.root, "config", "core.quotePath", "true");
    write(run.root, "café.js", "it.only('t', () => {})\n");
    git(run.root, "add", "-A");
    expect(await claim(run)).toEqual(drift("café.js:1  it.only('t', () => {})"));
  });

  test("drift-guard: an external diff driver cannot replace the parse input", async () => {
    const run = seeded("a.js");
    git(run.root, "config", "diff.external", "true");
    append(run.root, "a.js", "it.only('t', () => {})\n");
    expect(await claim(run)).toEqual(drift("a.js:2  it.only('t', () => {})"));
  });

  test("drift-guard: specify.only, it.concurrent.only and serial.only are markers", async () => {
    const run = seeded("a.js");
    append(run.root, "a.js", "specify.only('a')\nit.concurrent.only('b')\ntest.describe.serial.only('c')\n");
    expect(await claim(run)).toEqual(drift("a.js:2  specify.only('a')", "a.js:3  it.concurrent.only('b')", "a.js:4  test.describe.serial.only('c')"));
  });

  test("drift-guard: Model.objects.only stays excluded", async () => {
    const run = seeded("a.js");
    append(run.root, "a.js", "qs = Model.objects.only('id')\n");
    expect(await claim(run)).toEqual({});
  });

  test("drift-guard: a focused-test spelling in a non-JS file is prose, not a runnable focused test", async () => {
    const run = seeded();
    write(run.root, "helper.sh", `echo "it.only(1)"\n`);
    write(run.root, "mod.py", `note = "it.only(2)"\n`);
    write(run.root, "notes.txt", `it.only("x")\n`);
    write(run.root, "suite.bats", `@test "it.only in a name" {\n\techo "it.only(3)"\n}\n`);
    expect(await claim(run)).toEqual({});
  });

  test("drift-guard: a focused test in a .ts file is still a finding", async () => {
    const run = seeded();
    write(run.root, "spec.ts", "it.only('x', () => {})\n");
    expect(await claim(run)).toEqual(drift("spec.ts:1  it.only('x', () => {})"));
  });

  test("drift-guard: an unfinished-implementation marker stays language-independent", async () => {
    const run = seeded();
    write(run.root, "helper.sh", `run() { : ; } # ${UNFINISHED}\n`);
    write(run.root, "mod.py", `def run(): pass  # ${UNFINISHED}\n`);
    write(run.root, "mod.rs", `fn run() {} // ${UNFINISHED}\n`);
    expect(await claim(run)).toEqual(
      drift(`helper.sh:1  run() { : ; } # ${UNFINISHED}`, `mod.py:1  def run(): pass  # ${UNFINISHED}`, `mod.rs:1  fn run() {} // ${UNFINISHED}`),
    );
  });

  test("drift-guard: a single-line hunk reports the file's own line number", async () => {
    const run = seeded("spec.js", "a\nb\nc\nd\ne\n");
    write(run.root, "spec.js", "a\nb\nc\nit.only('x')\ne\n");
    expect(await claim(run)).toEqual(drift("spec.js:4  it.only('x')"));
  });

  test("drift-guard: removed lines before an addition do not shift the reported line", async () => {
    const run = seeded("spec.js", "a\nb\nc\nd\ne\nf\n");
    write(run.root, "spec.js", "a\nb\nit.only('x')\nf\n");
    expect(await claim(run)).toEqual(drift("spec.js:3  it.only('x')"));
  });
});

describe("stop ledger", () => {
  function completeRepository(): Stop {
    const run = session(repository());
    write(run.root, "a.js", "seed\n");
    commitAll(run.root);
    bind(run, COMPLETE_PLAN, { boundAt: 1 });
    return run;
  }

  test("stop ledger: a resetting gate does not refund a blocking sibling's budget", async () => {
    const run = completeRepository();
    const block = unverified(join(run.root, "plan.md"));
    expect(await stops(run, 7, { last_assistant_message: CLAIM })).toEqual([block, block, block, block, block, {}, {}]);
    expect([...(findSession(run.sessionId)?.stopBlocks ?? [])]).toEqual([["final-verification", 5]]);
  });

  test("stop ledger: a gate's own reset clears only its own key", async () => {
    const run = completeRepository();
    expect((await stops(run, 3)).map((answer) => answer.hookSpecificOutput?.hookEventName)).toEqual(["Stop", "Stop", "Stop"]);
    onlyGate("drift-guard");
    append(run.root, "a.js", "it.only('t', () => {})\n");
    expect(await run.stop({ last_assistant_message: "Done." })).toEqual(drift("a.js:2  it.only('t', () => {})"));
    git(run.root, "checkout", "-q", "--", "a.js");
    expect(await run.stop({ last_assistant_message: "Done." })).toEqual({});
    expect([...(findSession(run.sessionId)?.stopBlocks ?? [])]).toEqual([["final-verification", 3]]);
  });
});

describe("disjointness matrix", () => {
  async function firing(run: Stop): Promise<StopGate[]> {
    const fired: StopGate[] = [];
    for (const gate of GATES) {
      onlyGate(gate);
      if ((await run.stop({ last_assistant_message: CLAIM })).hookSpecificOutput !== undefined) fired.push(gate);
    }
    return fired;
  }

  function planRepository(plan: string, withStub = false): Stop {
    const run = session(repository());
    write(run.root, "a.txt", "hello\n");
    commitAll(run.root);
    bind(run, plan);
    if (withStub) write(run.root, "stub.sh", `# ${UNFINISHED} pagination\n`);
    return run;
  }

  test("disjointness matrix: unchecked plan state", async () => {
    expect(await firing(planRepository(UNCHECKED_PLAN))).toEqual(["plan-continuation"]);
  });

  test("disjointness matrix: fully-checked plan state", async () => {
    expect(await firing(planRepository(COMPLETE_PLAN))).toEqual(["final-verification"]);
  });

  test("disjointness matrix: no-checkboxes plan state", async () => {
    expect(await firing(planRepository(NO_BOXES_PLAN))).toEqual([]);
  });

  test("disjointness matrix: malformed-only (unnumbered) checkbox plan state", async () => {
    expect(await firing(planRepository(MALFORMED_PLAN))).toEqual([]);
  });

  test("disjointness matrix: drift-guard co-fires with plan continuation on a stub plus an unchecked plan", async () => {
    expect(await firing(planRepository(UNCHECKED_PLAN, true))).toEqual(["plan-continuation", "drift-guard"]);
  });

  test("disjointness matrix: two co-firing gates still run out of Stop-block budget", async () => {
    const run = planRepository(UNCHECKED_PLAN, true);
    const stub = drift(`stub.sh:1  # ${UNFINISHED} pagination`);
    expect(await stops(run, 8, { last_assistant_message: CLAIM })).toEqual([CONTINUE, stub, stub, stub, stub, stub, {}, {}]);
  });
});

describe("the Stop handler", () => {
  test("stop-gates in OMCA_DISABLED_HOOKS turns off all three gates", async () => {
    const run = session();
    bind(run, UNCHECKED_PLAN);
    process.env.OMCA_DISABLED_HOOKS = "stop-gates";
    expect(await run.stop()).toEqual({});
    writeRegistry(run.root, "NOT JSON {");
    expect(await run.stop()).toEqual({});
  });

  test("one Stop reads the bound plan once for both plan gates", async () => {
    const reads = spyOn(statusFile, "readBoundPlan");
    try {
      const run = session();
      const plan = bind(run, COMPLETE_PLAN);
      expect(await run.stop()).toEqual(unverified(plan));
      expect(reads).toHaveBeenCalledTimes(1);
    } finally {
      reads.mockRestore();
    }
  });

  test("hooks.json routes Stop to omca_hook through one entry and registers no StopFailure handler", () => {
    const { hooks } = JSON.parse(readFileSync(HOOKS, "utf8"));
    expect(hooks.StopFailure).toBeUndefined();
    expect(hooks.Stop).toEqual([
      {
        hooks: [
          {
            type: "mcp_tool",
            server: "plugin:oh-my-claudeagent:omca",
            tool: "omca_hook",
            timeout: 15,
            input: {
              event: "Stop",
              session_id: "${session_id}",
              transcript_path: "${transcript_path}",
              stop_hook_active: "${stop_hook_active}",
              last_assistant_message: "${last_assistant_message}",
              background_tasks: "${background_tasks}",
            },
          },
        ],
      },
    ]);
  });
});
