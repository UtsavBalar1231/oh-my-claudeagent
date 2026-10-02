import { describe, expect, test } from "bun:test";
import { type ActionFacts, hasPassingFinalVerification, type NextAction, nextActions } from "./next-actions.ts";

const PATH = "/work/plans/widget-rewrite.md";
const OPEN = { name: "widget-rewrite", path: PATH, done: 12, total: 46 };
const DONE = { ...OPEN, done: 46 };
const UNLOGGED = { command: "just test", isLogged: false };
const NONE: ActionFacts = { plan: null, verification: null, isAgentRunning: false, hasFinalVerification: false };

const LOG: NextAction = { kind: "log-evidence", label: "Log evidence", prompt: "Log evidence for `just test` with evidence_log" };
const START: NextAction = { kind: "start-work", label: "Start work", prompt: `/oh-my-claudeagent:start-work ${PATH}` };
const FINAL: NextAction = {
  kind: "final-verification",
  label: "Run final verification",
  prompt: "Run the final verification for widget-rewrite",
};
const REVIEW: NextAction = {
  kind: "review",
  label: "Review with oracle",
  prompt: "Review the changes made for widget-rewrite with oracle",
};

describe("nextActions", () => {
  test.each<[string, Partial<ActionFacts>, NextAction[]]>([
    ["nothing bound and nothing run", {}, []],
    ["an unlogged verification alone", { verification: UNLOGGED }, [LOG]],
    ["a logged verification alone", { verification: { command: "just test", isLogged: true } }, []],
    ["a plan with open tasks and no running agent", { plan: OPEN }, [START]],
    ["a plan with open tasks while an agent runs", { plan: OPEN, isAgentRunning: true }, []],
    ["a complete plan without a passing final verification", { plan: DONE }, [FINAL]],
    ["a complete plan with one", { plan: DONE, hasFinalVerification: true }, [REVIEW]],
    ["a complete plan with one while an agent runs", { plan: DONE, isAgentRunning: true, hasFinalVerification: true }, [REVIEW]],
    ["a plan with no numbered tasks", { plan: { ...OPEN, done: 0, total: 0 } }, []],
    ["the unlogged verification ahead of start-work", { plan: OPEN, verification: UNLOGGED }, [LOG, START]],
    ["the unlogged verification ahead of the final verification", { plan: DONE, verification: UNLOGGED }, [LOG, FINAL]],
    [
      "the unlogged verification ahead of the review",
      { plan: DONE, verification: UNLOGGED, hasFinalVerification: true },
      [LOG, REVIEW],
    ],
  ])("%s", (_title, facts, expected) => {
    expect(nextActions({ ...NONE, ...facts })).toEqual(expected);
  });

  test("the fill text carries the command verbatim, backticks around it", () => {
    expect(nextActions({ ...NONE, verification: { command: "bun test src/a b.spec.ts", isLogged: false } })).toEqual([
      { ...LOG, prompt: "Log evidence for `bun test src/a b.spec.ts` with evidence_log" },
    ]);
  });
});

describe("hasPassingFinalVerification", () => {
  const SHA = "a".repeat(64);
  const entry = (fields: Record<string, unknown>) => ({ entries: [{ type: "final_verification", exit_code: 0, ...fields }] });

  test.each<[string, unknown, boolean]>([
    ["an entry scoped to this plan's bytes", entry({ plan_sha256: SHA }), true],
    ["an entry with no plan_sha256", entry({}), true],
    ["an entry with an empty plan_sha256", entry({ plan_sha256: "" }), true],
    ["an entry with a null plan_sha256", entry({ plan_sha256: null }), true],
    ["an entry scoped to other bytes", entry({ plan_sha256: "b".repeat(64) }), false],
    ["a failing entry", entry({ exit_code: 1 }), false],
    ["an exit code given as a string", entry({ exit_code: "0" }), false],
    ["a passing entry of another type", { entries: [{ type: "test", exit_code: 0 }] }, false],
    ["a passing entry after a failing one", { entries: [...entry({ exit_code: 2 }).entries, ...entry({}).entries] }, true],
    ["no ledger", undefined, false],
    ["a ledger without entries", {}, false],
    ["entries that are not an array", { entries: "final_verification" }, false],
    ["entries that are not objects", { entries: [null, 3, "x"] }, false],
  ])("%s: %p", (_title, ledger, expected) => {
    expect(hasPassingFinalVerification(ledger, SHA)).toBe(expected);
  });
});
