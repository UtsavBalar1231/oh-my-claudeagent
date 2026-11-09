import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVIDENCE_LOG_TOOL } from "../../src/core/verification.ts";
import { dispatch, type Payload } from "./registry.ts";
import { touchSession } from "./session-state.ts";
import { statusPath } from "./status-file.ts";

const NOW = 1_786_000_000_000;
const NOW_S = NOW / 1000;
const NOTE = {
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    classifierContext:
      "This Bash call ran one of this repository's own verification runners (test, lint, build, or typecheck).",
  },
};

const roots: string[] = [];

afterEach(() => {
  delete process.env.OMCA_DISABLED_HOOKS;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "omca-recorder-"));
  roots.push(root);
  return root;
}

const POWERSHELL_NOTE = {
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    classifierContext:
      "This PowerShell call ran one of this repository's own verification runners (test, lint, build, or typecheck).",
  },
};

const bash = (sessionId: string, fields: Record<string, unknown>): Payload => ({
  event: "PostToolUse",
  session_id: sessionId,
  tool_name: "Bash",
  ...fields,
});

const record = (root: string, sessionId: string, command: string, now = NOW, agentId = "") =>
  dispatch(bash(sessionId, { tool_input: { command }, agent_id: agentId }), root, now);

const logEvidence = (root: string, sessionId: string, now = NOW, agentId = "", event = "PostToolUse") =>
  dispatch(
    {
      event,
      session_id: sessionId,
      agent_id: agentId,
      tool_name: EVIDENCE_LOG_TOOL,
      tool_input: { evidence_type: "test", command: "just test", exit_code: 0, output_snippet: "10 passed" },
      ...(event === "PostToolUse" ? { tool_response: [{ type: "text", text: "Evidence recorded: test (exit 0), 1 total entries" }] } : { error: "evidence_log: the ledger could not be read" }),
    },
    root,
    now,
  );

const failed = (sessionId: string, command: string, error: string, agentId = ""): Payload => ({
  event: "PostToolUseFailure",
  session_id: sessionId,
  agent_id: agentId,
  tool_name: "Bash",
  tool_input: { command },
  error,
});

const slotOf = (sessionId: string, agentId: string) => touchSession(sessionId).verifications?.get(agentId);

const slot = (root: string, sessionId: string): unknown =>
  JSON.parse(readFileSync(statusPath(root, sessionId), "utf8")).verification;

const nothingRecorded = (root: string, sessionId: string) => {
  expect(slot(root, sessionId)).toBeNull();
  expect(touchSession(sessionId).verifications?.get("")).toBeUndefined();
};

describe("recognised runners", () => {
  test("recorder: bare 'just test' records a slot", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    expect(await record(root, sessionId, "just test")).toEqual(NOTE);
    expect(JSON.parse(readFileSync(statusPath(root, sessionId), "utf8"))).toEqual({
      session_id: sessionId,
      last_hook_at: NOW_S,
      verification: { command: "just test", at: NOW_S, exit_code: null, evidence_logged: false },
    });
    expect(touchSession(sessionId).verifications?.get("")).toEqual({ command: "just test", at: NOW_S, exit_code: null, evidence_logged: false });
  });

  test("recorder: a runner after && is anchored and records", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId, "cd servers && uv run --project . pytest -q");
    expect(slot(root, sessionId)).toMatchObject({ command: "cd servers && uv run --project . pytest -q" });
  });

  test("recorder: each ecosystem runner in the list records", async () => {
    const root = project();
    const commands = ["just ci", "npm test", "pnpm run lint", "cargo clippy", "go vet ./...", "make check", "bats tests/bats", "tsc --noEmit", "ruff check servers/", "shellcheck scripts/x.sh"];
    const recorded = [];
    for (const command of commands) {
      const sessionId = crypto.randomUUID();
      await record(root, sessionId, command);
      recorded.push((slot(root, sessionId) as { command: string } | null)?.command);
    }
    expect(recorded).toEqual(commands);
  });

  test("recorder: a hyphenated test or lint recipe records", async () => {
    const root = project();
    const commands = ["just test-hooks", "just test-unit", "just test-e2e", "just test-mcp", "just test-all", "just lint-css", "just lint-docs", "just typecheck"];
    const recorded = [];
    for (const command of commands) {
      const sessionId = crypto.randomUUID();
      await record(root, sessionId, command);
      recorded.push((slot(root, sessionId) as { command: string } | null)?.command);
    }
    expect(recorded).toEqual(commands);
  });

  test("recorder: a suffix on a non-check recipe records nothing", async () => {
    const root = project();
    for (const command of ["just fmt", "just build-and-deploy", "just release 2.19.0", "just install-hooks"]) {
      const sessionId = crypto.randomUUID();
      expect(await record(root, sessionId, command)).toEqual({});
      nothingRecorded(root, sessionId);
    }
  });
});

describe("PowerShell and Windows runner names", () => {
  test("recorder: a PowerShell verification records a slot and answers a PowerShell note", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    const payload = { ...bash(sessionId, { tool_input: { command: "npm.cmd test" }, tool_response: { exitCode: 1 } }), tool_name: "PowerShell" };
    expect(await dispatch(payload, root, NOW)).toEqual(POWERSHELL_NOTE);
    expect(JSON.parse(readFileSync(statusPath(root, sessionId), "utf8"))).toEqual({
      session_id: sessionId,
      last_hook_at: NOW_S,
      verification: { command: "npm.cmd test", at: NOW_S, exit_code: 1, evidence_logged: false },
    });
    expect(touchSession(sessionId).verifications?.get("")).toEqual({ command: "npm.cmd test", at: NOW_S, exit_code: 1, evidence_logged: false });
  });

  test("recorder: a PowerShell call that is not a verification records nothing", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    const payload = (command: string) => ({ ...bash(sessionId, { tool_input: { command } }), tool_name: "PowerShell" });
    for (const command of ["Get-ChildItem", "Write-Host 'bun.exe test'", 'Write-Host "npm.cmd test"', "git commit -m 'run just test'"]) {
      expect(await dispatch(payload(command), root, NOW)).toEqual({});
    }
    nothingRecorded(root, sessionId);
  });

  test("recorder: the .cmd and .exe runner names record under Bash too", async () => {
    const root = project();
    for (const command of ["bun.exe test", "npm.cmd test", "tsc.cmd --noEmit", "just.exe ci"]) {
      const sessionId = crypto.randomUUID();
      expect(await record(root, sessionId, command)).toEqual(NOTE);
      expect(slot(root, sessionId)).toMatchObject({ command });
    }
  });

  test("recorder: a tool whose name only starts like a shell records nothing", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    for (const tool_name of ["PowerShellX", "Bash2", "powershell", "bash"]) {
      const payload = { ...bash(sessionId, { tool_input: { command: "just test" } }), tool_name };
      expect(await dispatch(payload, root, NOW)).toEqual({});
    }
    nothingRecorded(root, sessionId);
  });

  test("recorder: OMCA_DISABLED_HOOKS listing this hook silences a PowerShell call too", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    process.env.OMCA_DISABLED_HOOKS = "verification-recorder";
    const payload = { ...bash(sessionId, { tool_input: { command: "just test" } }), tool_name: "PowerShell" };
    expect(await dispatch(payload, root, NOW)).toEqual({});
    nothingRecorded(root, sessionId);
  });
});

describe("mentions are not invocations", () => {
  test("recorder: a runner inside a double-quoted span records nothing", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    expect(await record(root, sessionId, 'echo "npm test"')).toEqual({});
    nothingRecorded(root, sessionId);
  });

  test("recorder: a runner inside a single-quoted span records nothing", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    expect(await record(root, sessionId, "printf '%s' 'just test'")).toEqual({});
    nothingRecorded(root, sessionId);
  });

  test("recorder: a commit message naming a runner records nothing", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    expect(await record(root, sessionId, 'git commit -m "fix the npm test flake"')).toEqual({});
    nothingRecorded(root, sessionId);
  });

  test("recorder: a runner chained after a commit message records", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    expect(await record(root, sessionId, 'git commit -m "fix the npm test flake" && npm test')).toEqual(NOTE);
    expect(slot(root, sessionId)).toMatchObject({ command: 'git commit -m "fix the npm test flake" && npm test' });
  });

  test("recorder: an unrecognised command records nothing", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    expect(await record(root, sessionId, "ls -la")).toEqual({});
    nothingRecorded(root, sessionId);
  });

  test("recorder: a mid-command flag value is not an invocation", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    expect(await record(root, sessionId, "grep --include=pytest -r x .")).toEqual({});
    nothingRecorded(root, sessionId);
  });

  test("recorder: a tool other than Bash records nothing", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    const payload = { ...bash(sessionId, { tool_input: { command: "just test" } }), tool_name: "Monitor" };
    expect(await dispatch(payload, root, NOW)).toEqual({});
    nothingRecorded(root, sessionId);
  });
});

describe("single-slot overwrite policy", () => {
  test("recorder: an unsatisfied slot survives a later verification", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId, "just test");
    expect(await record(root, sessionId, "just lint", NOW + 10_000)).toEqual(NOTE);
    expect(slot(root, sessionId)).toEqual({ command: "just test", at: NOW_S, exit_code: null, evidence_logged: false });
  });

  test("recorder: an unsatisfied slot older than an hour is replaced by a later verification", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId, "just test");
    await record(root, sessionId, "just lint", NOW + 3_601_000);
    expect(slot(root, sessionId)).toEqual({
      command: "just lint",
      at: NOW_S + 3601,
      exit_code: null,
      evidence_logged: false,
    });
  });

  test("recorder: a satisfied slot is replaced by a later verification", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId, "just test");
    await logEvidence(root, sessionId, NOW + 60_000);
    await record(root, sessionId, "just lint", NOW + 120_000);
    expect(slot(root, sessionId)).toEqual({ command: "just lint", at: NOW_S + 120, exit_code: null, evidence_logged: false });
  });

  test("recorder: a verification in another session leaves this session's slot alone", async () => {
    const root = project();
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    await record(root, first, "just test");
    await record(root, second, "just lint");
    expect([slot(root, first), slot(root, second)]).toEqual([
      { command: "just test", at: NOW_S, exit_code: null, evidence_logged: false },
      { command: "just lint", at: NOW_S, exit_code: null, evidence_logged: false },
    ]);
  });
});

describe("a verification belongs to the agent that ran it", () => {
  test("a subagent's verification is kept under its agent id and leaves the status file's slot empty", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    expect(await record(root, sessionId, "bun run build", NOW, "a54ee4c474f89151b")).toEqual(NOTE);
    expect(slotOf(sessionId, "a54ee4c474f89151b")).toEqual({ command: "bun run build", at: NOW_S, exit_code: null, evidence_logged: false });
    expect(slotOf(sessionId, "")).toBeUndefined();
  });

  test("the main conversation's own evidence_log marks its slot logged in the session and the status file", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId, "just test");
    expect(await logEvidence(root, sessionId, NOW + 5_000)).toEqual({});
    expect(slotOf(sessionId, "")?.evidence_logged).toBe(true);
    expect(slot(root, sessionId)).toEqual({ command: "just test", at: NOW_S, exit_code: null, evidence_logged: true });
  });

  test("a subagent's evidence_log leaves the main conversation's slot unlogged", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId, "just test");
    await logEvidence(root, sessionId, NOW + 5_000, "a79f8f1889e2d7984");
    expect(slotOf(sessionId, "")?.evidence_logged).toBe(false);
    expect(slot(root, sessionId)).toMatchObject({ evidence_logged: false });
  });

  test("a subagent's evidence_log marks that subagent's own slot", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId, "bun test", NOW, "a79f8f1889e2d7984");
    await logEvidence(root, sessionId, NOW + 5_000, "a79f8f1889e2d7984");
    expect(slotOf(sessionId, "a79f8f1889e2d7984")?.evidence_logged).toBe(true);
  });

  test("an evidence_log call the server refused marks nothing", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId, "just test");
    await logEvidence(root, sessionId, NOW + 5_000, "", "PostToolUseFailure");
    expect(slotOf(sessionId, "")?.evidence_logged).toBe(false);
  });

  test("an evidence_log with no recorded verification creates no slot", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await logEvidence(root, sessionId);
    expect(touchSession(sessionId).verifications).toBeUndefined();
  });

  test("a new verification drops other agents' slots older than an hour", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await record(root, sessionId, "just test", NOW, "early-agent");
    await record(root, sessionId, "just lint", NOW + 3_601_000);
    expect([...(touchSession(sessionId).verifications?.keys() ?? [])]).toEqual([""]);
  });
});

describe("a failed verification is recorded too", () => {
  test("a run that exited non-zero records its exit code and answers no note", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    const error = "Exit code 1\nbun test v1.4.2 (744846f84)\nerror: 0 test files matching **{.test,.spec}.{js,ts}";
    expect(await dispatch(failed(sessionId, "bun test", error), root, NOW)).toEqual({});
    expect(slot(root, sessionId)).toEqual({ command: "bun test", at: NOW_S, exit_code: 1, evidence_logged: false });
  });

  test("a failed run under a subagent is that subagent's", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await dispatch(failed(sessionId, "cargo test", "Exit code 101\nerror: test failed", "a54ee4c474f89151b"), root, NOW);
    expect(slotOf(sessionId, "a54ee4c474f89151b")).toEqual({ command: "cargo test", at: NOW_S, exit_code: 101, evidence_logged: false });
    expect(slotOf(sessionId, "")).toBeUndefined();
  });

  test("a failure with no exit code line means the command never ran and records nothing", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await dispatch(failed(sessionId, "just test", "spawn /bin/bash ENOENT"), root, NOW);
    expect(touchSession(sessionId).verifications).toBeUndefined();
  });

  test("a failed command that is not a verification records nothing", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await dispatch(failed(sessionId, "ls missing-dir", "Exit code 2\nls: cannot access 'missing-dir'"), root, NOW);
    expect(touchSession(sessionId).verifications).toBeUndefined();
  });
});

describe("exit_code is display-only", () => {
  test("recorder: exitCode is carried through when present", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    await dispatch(bash(sessionId, { tool_input: { command: "just test" }, tool_response: { exitCode: 1 } }), root, NOW);
    expect(slot(root, sessionId)).toMatchObject({ exit_code: 1 });
  });

  test("recorder: a non-object tool_response degrades exit_code to null", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    const output = await dispatch(bash(sessionId, { tool_input: { command: "just test" }, tool_response: "some text" }), root, NOW);
    expect(output).toEqual(NOTE);
    expect(slot(root, sessionId)).toMatchObject({ exit_code: null });
  });
});

describe("kill switch and malformed input", () => {
  test("recorder: OMCA_DISABLED_HOOKS listing this hook records nothing", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    process.env.OMCA_DISABLED_HOOKS = "verification-recorder";
    expect(await record(root, sessionId, "just test")).toEqual({});
    nothingRecorded(root, sessionId);
  });

  test("recorder: a payload with no command answers nothing and records nothing", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    expect(await dispatch(bash(sessionId, { tool_input: {} }), root, NOW)).toEqual({});
    nothingRecorded(root, sessionId);
  });

  test("recorder: a payload with no session id still answers the note and records nothing", async () => {
    const root = project();
    expect(await dispatch({ event: "PostToolUse", tool_name: "Bash", tool_input: { command: "just test" } }, root, NOW)).toEqual(NOTE);
  });
});

describe("classifier note", () => {
  test("classifier note: a recognised runner emits the note and still records a slot", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    expect(await record(root, sessionId, "just test")).toEqual(NOTE);
    expect(slot(root, sessionId)).toMatchObject({ command: "just test" });
  });

  test("classifier note: the note is a single short assertion within the platform cap", async () => {
    const output = await record(project(), crypto.randomUUID(), "just ci");
    const note = String(output.hookSpecificOutput?.classifierContext);
    // 2000 characters is the platform's per-call cap, shared by every hook answering the call.
    expect(note.length).toBeLessThan(2000);
    expect(note).not.toContain("\n");
  });
});

describe("a full hook payload", () => {
  test("a full payload records a slot with the exit code and answers the note", async () => {
    const root = project();
    const fixture = {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "just test" },
      tool_response: { exitCode: 0 },
      session_id: "fixture-sid-001",
    };
    expect(await dispatch({ ...fixture, event: fixture.hook_event_name }, root, NOW)).toEqual(NOTE);
    expect(slot(root, "fixture-sid-001")).toEqual({ command: "just test", at: NOW_S, exit_code: 0, evidence_logged: false });
  });
});

test("hooks.json sends shell results, failures and evidence_log calls to the recorder, and registers nothing on PermissionRequest", () => {
  const hooks = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "hooks", "hooks.json"), "utf8")).hooks;
  const tools = hooks.PostToolUse.flatMap((group: { matcher: string }) => group.matcher.split("|"));
  expect(tools).toEqual(expect.arrayContaining(["Bash", "PowerShell", EVIDENCE_LOG_TOOL]));
  expect(hooks.PostToolUseFailure.map((group: { matcher?: string }) => group.matcher)).toEqual([undefined]);
  expect(hooks.PermissionRequest).toBeUndefined();
});
