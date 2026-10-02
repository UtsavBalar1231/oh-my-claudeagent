import { describe, expect, test } from "bun:test";
import { MAX_SLOT_AGE_SECONDS } from "./evidence.ts";
import {
  blankQuotedSpans,
  exitCodeOf,
  isVerificationCommand,
  keepsSlot,
  unloggedReason,
} from "./verification.ts";

describe("isVerificationCommand", () => {
  test.each([
    "just test",
    "just ci",
    "just fmt-check",
    "just typecheck",
    "just build",
    "just test-hooks",
    "just lint-shell",
    "npm test",
    "bun test",
    "pnpm run lint",
    "yarn run build",
    "pytest -q",
    "cargo clippy",
    "go vet ./...",
    "make check",
    "bats tests/bats",
    "tsc --noEmit",
    "ruff check servers/",
    "shellcheck scripts/x.sh",
    "cd servers && uv run --project . pytest -q",
    "git status; just test",
    "(bun test)",
    "true | npm test",
    "  just test",
  ])("records %p", (command) => {
    expect(isVerificationCommand(command)).toBe(true);
  });

  test.each([
    "ls -la",
    "just fmt",
    "just build-and-deploy",
    "just release 2.19.0",
    "just testing",
    "npm install",
    "bun run dev",
    "grep --include=pytest -r x .",
    "echo just test",
    'echo "npm test"',
    "printf '%s' 'just test'",
    'git commit -m "make npm test pass"',
    "git commit -m 'run just test before merging'",
    'gh pr create --body "ran just ci; all green"',
  ])("ignores %p", (command) => {
    expect(isVerificationCommand(command)).toBe(false);
  });

  test("a runner after a quoted mention still records", () => {
    expect(isVerificationCommand('git commit -m "wip" && npm test')).toBe(true);
  });
});

describe("blankQuotedSpans", () => {
  test("blanks paired spans of either quote and keeps the delimiters", () => {
    expect(blankQuotedSpans(`echo "npm test" 'just ci' done`)).toBe(`echo "" '' done`);
  });

  test("a span never pairs across a newline, so the lone quote stays literal", () => {
    expect(blankQuotedSpans('echo "a\nb" c')).toBe('echo "a\nb" c');
  });

  test("an unpaired quote stays literal and later text is still scanned", () => {
    expect(blankQuotedSpans(`it's; just test`)).toBe(`it's; just test`);
    expect(isVerificationCommand(`echo it's; just test`)).toBe(true);
  });
});

describe("keepsSlot", () => {
  test("keeps a slot no evidence followed", () => {
    expect(keepsSlot({ command: "just test", at: 100, exit_code: null }, 99, 200)).toBe(true);
  });

  test("replaces a slot evidence covered, including evidence in the same second", () => {
    expect(keepsSlot({ command: "just test", at: 100, exit_code: null }, 100, 200)).toBe(false);
  });

  test("has nothing to keep without a slot", () => {
    expect(keepsSlot(undefined, 0, 200)).toBe(false);
  });

  test("replaces an unsatisfied slot once the gate treats it as stale", () => {
    const slot = { command: "just test", at: 100, exit_code: null };
    expect(keepsSlot(slot, 99, 100 + MAX_SLOT_AGE_SECONDS)).toBe(true);
    expect(keepsSlot(slot, 99, 101 + MAX_SLOT_AGE_SECONDS)).toBe(false);
  });
});

describe("exitCodeOf", () => {
  test("reads exitCode, then exit_code", () => {
    expect(exitCodeOf({ exitCode: 1 })).toBe(1);
    expect(exitCodeOf({ exit_code: 2 })).toBe(2);
    expect(exitCodeOf({ exitCode: 0, exit_code: 3 })).toBe(0);
  });

  test("degrades any other shape to null", () => {
    expect([exitCodeOf("some text"), exitCodeOf(undefined), exitCodeOf([1]), exitCodeOf({ exitCode: "1" })]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });
});

describe("unloggedReason", () => {
  test("names the command and its local time and points at evidence_log", () => {
    const previous = process.env.TZ;
    process.env.TZ = "UTC";
    try {
      expect(unloggedReason({ command: "just test", at: 1_786_000_000, exit_code: null })).toBe(
        "You ran `just test` at 07:06 but logged no evidence after it. Log the real result with evidence_log, " +
          'including a non-zero exit_code if it failed. Example: evidence_log(evidence_type="test", ' +
          'command="just test", exit_code=0, output_snippet="10 passed")',
      );
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});
