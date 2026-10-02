import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch, type Payload } from "./registry.ts";
import { touchSession } from "./session-state.ts";
import { ledgerPath, statusPath } from "./status-file.ts";

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

const record = (root: string, sessionId: string, command: string, now = NOW) =>
  dispatch(bash(sessionId, { tool_input: { command } }), root, now);

const slot = (root: string, sessionId: string): unknown =>
  JSON.parse(readFileSync(statusPath(root, sessionId), "utf8")).verification;

const nothingRecorded = (root: string, sessionId: string) => {
  expect(slot(root, sessionId)).toBeNull();
  expect(touchSession(sessionId).verification).toBeUndefined();
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
    expect(touchSession(sessionId).verification).toEqual({ command: "just test", at: NOW_S, exit_code: null });
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
    const commands = ["just test-hooks", "just test-bats", "just test-pytest", "just test-mcp", "just test-all", "just lint-shell", "just lint-python", "just typecheck"];
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
    expect(touchSession(sessionId).verification).toEqual({ command: "npm.cmd test", at: NOW_S, exit_code: 1 });
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
    mkdirSync(join(root, ".omca", "evidence"), { recursive: true });
    writeFileSync(ledgerPath(root), '{"entries":[]}');
    utimesSync(ledgerPath(root), NOW_S + 60, NOW_S + 60);
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

  test("recorder: a payload with no command exits 0 and records nothing", async () => {
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

  test("classifier note: an unrecognised command emits no note and records no slot", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    expect(await record(root, sessionId, "ls -la")).toEqual({});
    nothingRecorded(root, sessionId);
  });

  test("classifier note: a quoted mention emits no note and records no slot", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    expect(await record(root, sessionId, 'echo "just test"')).toEqual({});
    nothingRecorded(root, sessionId);
  });

  test("classifier note: the note is a single short assertion within the platform cap", async () => {
    const output = await record(project(), crypto.randomUUID(), "just ci");
    const note = String(output.hookSpecificOutput?.classifierContext);
    // 2000 characters is the platform's per-call cap, shared by every hook answering the call.
    expect(note.length).toBeLessThan(2000);
    expect(note).not.toContain("\n");
  });

  test("classifier note: the disabled hook emits nothing", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    process.env.OMCA_DISABLED_HOOKS = "all";
    expect(await record(root, sessionId, "just test")).toEqual({});
    nothingRecorded(root, sessionId);
  });
});

describe("golden fixtures", () => {
  test("records-slot replays to the note and a slot with the exit code", async () => {
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

  test("quoted-mention replays to an empty answer and no slot", async () => {
    const root = project();
    const fixture = {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: 'echo "npm test"' },
      session_id: "fixture-sid-002",
    };
    expect(await dispatch({ ...fixture, event: fixture.hook_event_name }, root, NOW)).toEqual({});
    nothingRecorded(root, "fixture-sid-002");
  });
});
