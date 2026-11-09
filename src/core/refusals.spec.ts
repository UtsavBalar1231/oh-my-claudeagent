import { describe, expect, test } from "bun:test";
import { COMMENT_ATTRIBUTION_HEAD, COMMENT_SLOP_HEAD, judgeWrite } from "./comments.ts";
import {
  classify,
  FORCE_PUSH_REASON,
  FORCE_PUSH_TITLE,
  GIT_REASON,
  gitTitle,
  NO_VERIFY_REASON,
  REVIEW_REFUSED_REASON,
  RM_CATASTROPHIC_REASON,
  RM_CATASTROPHIC_TITLE,
  RM_TITLE,
  titleFor,
} from "./destructive.ts";
import {
  internalFinalReason,
  noPassingVerdictReason,
  noVerdictReason,
  type Refusal,
  refusalOf,
  stayFinalReason,
} from "./refusals.ts";
import { INVALID_LEDGER_REASON, unloggedReason } from "./verification.ts";

const wrappers: readonly [string, (reason: string) => string][] = [
  ["a tool.check deny", (reason) => `Error: Permission to use Bash denied by plugins oh-my-claudeagent, cc-plugin-privacy: ${reason}`],
  ["a one-plugin tool.check deny", (reason) => `Error: Permission to use Bash denied by plugin oh-my-claudeagent: ${reason}`],
  ["a PreToolUse hook error", (reason) => `Error: PreToolUse:TaskUpdate hook error: ${reason}`],
  ["a TaskCompleted hook feedback", (reason) => `TaskCompleted hook feedback:\n${reason}`],
];

const slop = judgeWrite("deny", { file_path: "/r/src/a.py", content: "# obviously the user name\nuser_name = input_value" }, new Map());
const attribution = judgeWrite("deny", { file_path: "/r/src/a.py", content: "# AI-generated helper\nx = 1" }, new Map());
const reasonOf = (verdict: unknown): string => {
  if (typeof verdict !== "object" || verdict === null || !("reason" in verdict) || typeof verdict.reason !== "string") throw new Error("no deny");
  return verdict.reason;
};

const cases: readonly [string, string, Refusal][] = [
  ["rm catastrophic", RM_CATASTROPHIC_REASON, { kind: "guard", title: RM_CATASTROPHIC_TITLE, remedy: "name a deeper path explicitly" }],
  ["git", GIT_REASON, { kind: "guard", title: "destructive git command", remedy: "if the working tree is dirty, report and stop" }],
  ["force push", FORCE_PUSH_REASON, { kind: "guard", title: FORCE_PUSH_TITLE, remedy: "push to another branch, or ask the user to push" }],
  ["no verify", NO_VERIFY_REASON, { kind: "guard", title: gitTitle("commit --no-verify"), remedy: "fix what the hook reports and commit without the flag" }],
  ["review refused", REVIEW_REFUSED_REASON, { kind: "review-refused", title: "the user refused this command", remedy: "ask the user how to proceed" }],
  ["stays final", stayFinalReason("7", "plan"), { kind: "final-kept", taskId: "7", title: "stays the run's final task" }],
  ["internal", internalFinalReason("7", "plan"), { kind: "final-kept", taskId: "7", title: "stays the run's final task" }],
  [
    "no verdict",
    noVerdictReason("7", "plan"),
    { kind: "final-unlogged", taskId: "7", title: "final task has no logged verdict", remedy: "record the verdict first with evidence_log" },
  ],
  [
    "no passing verdict",
    noPassingVerdictReason("7", "ship it", "plan"),
    {
      kind: "completion-held",
      taskId: "7",
      title: "completion held: no passing verdict names it",
      remedy: "review the run, then record the verdict with evidence_log",
    },
  ],
  [
    "unlogged",
    unloggedReason({ command: "bun test\nbun lint", at: 1_700_000_000, exit_code: 1, evidence_logged: false }),
    {
      kind: "verification-unlogged",
      title: "completion held: a verification ran and is not logged",
      remedy: "log the real result with evidence_log, including a non-zero exit_code if it failed",
    },
  ],
  ["ledger", INVALID_LEDGER_REASON, { kind: "ledger-invalid", title: "evidence ledger invalid", remedy: "log with the evidence_log tool, not manual file writes" }],
  [
    "comment slop",
    reasonOf(slop),
    {
      kind: "comment",
      title: "comment slop",
      remedy: "delete the quoted comment, or rewrite it as the reason the code is the way it is",
      detail: "obviously the user name",
    },
  ],
  [
    "comment attribution",
    reasonOf(attribution),
    {
      kind: "comment",
      title: "AI-attribution or placeholder comment",
      remedy: "delete the quoted comment, or rewrite it as the reason the code is the way it is",
    },
  ],
];

describe("refusalOf", () => {
  for (const [wrapperName, wrap] of wrappers) {
    for (const [name, reason, expected] of cases) {
      test(`${name} inside ${wrapperName}`, () => {
        expect(refusalOf(wrap(reason))).toEqual(expected);
      });
    }
  }

  test("the comment reasons start with the exported heads", () => {
    expect(reasonOf(slop).startsWith(COMMENT_SLOP_HEAD)).toBe(true);
    expect(reasonOf(attribution).startsWith(COMMENT_ATTRIBUTION_HEAD)).toBe(true);
  });

  test("the task reasons keep their text and open with the task id", () => {
    expect(stayFinalReason("3", "r")).toBe("Task #3 is the final task of run 'r', and it stays final.");
    expect(internalFinalReason("3", "r")).toBe("Task #3 is the final task of run 'r', and it stays final: an internal task drops out of the run.");
    expect(noVerdictReason("3", "r")).toStartWith("Task #3 is the final task of run 'r', and no final verification names it. Record the verdict first: ");
    expect(noPassingVerdictReason("3", "s", "r")).toStartWith("Task #3 's' is the final task of run 'r', and no passing final verification names it. Review the run");
  });

  test("a run name or a subject holding quotes still reads", () => {
    expect(refusalOf(`TaskCompleted hook feedback:\n${noPassingVerdictReason("12", "fix 'x' now", "it's a run")}`)).toMatchObject({
      kind: "completion-held",
      taskId: "12",
    });
    expect(refusalOf(`Error: PreToolUse:TaskUpdate hook error: ${stayFinalReason("12", "it's a run")}`)).toMatchObject({ kind: "final-kept", taskId: "12" });
  });

  test("a reason after another hook's text on its own line is found", () => {
    const joined = `Error: PreToolUse:TaskUpdate hook error: another plugin refused this\n${stayFinalReason("4", "plan")}`;
    expect(refusalOf(joined)).toMatchObject({ kind: "final-kept", taskId: "4" });
    const wrapped = `Error: PreToolUse:TaskUpdate hook error: another plugin refused this\nError: PreToolUse:TaskUpdate hook error: ${INVALID_LEDGER_REASON}`;
    expect(refusalOf(wrapped)).toMatchObject({ kind: "ledger-invalid" });
  });

  test("the first of two OMCA reasons wins", () => {
    const joined = `TaskCompleted hook feedback:\n${noPassingVerdictReason("4", "s", "plan")}\n${INVALID_LEDGER_REASON}`;
    expect(refusalOf(joined)).toMatchObject({ kind: "completion-held" });
  });

  test("a failed command whose output starts with a reason, with no wrapper, is not a refusal", () => {
    expect(refusalOf(FORCE_PUSH_REASON)).toBeUndefined();
    expect(refusalOf(`${FORCE_PUSH_REASON}\nexit 1`)).toBeUndefined();
    expect(refusalOf(stayFinalReason("1", "plan"))).toBeUndefined();
  });

  test("a reason quoted in the middle of other text is not a refusal", () => {
    expect(refusalOf(`expected ${FORCE_PUSH_REASON} received nothing`)).toBeUndefined();
    expect(refusalOf(`Error: Permission to use Bash denied by plugins a, b: the spec printed ${FORCE_PUSH_REASON}`)).toBeUndefined();
    expect(refusalOf(`Error: PreToolUse:Bash hook error: a mention of "${INVALID_LEDGER_REASON}"`)).toBeUndefined();
  });

  test("a wrapper holding another plugin's reason, unknown text and the empty string are not refusals", () => {
    expect(refusalOf("Error: Permission to use Bash denied by plugins a, b: nope")).toBeUndefined();
    expect(refusalOf("Error: PreToolUse:Bash hook error: Task #1 is the final task of run 'x', and something else")).toBeUndefined();
    expect(refusalOf("TaskCompleted hook feedback:\n")).toBeUndefined();
    expect(refusalOf("command not found")).toBeUndefined();
    expect(refusalOf("")).toBeUndefined();
  });
});

describe("titleFor", () => {
  const at = (command: string) => {
    const finding = classify(command);
    if (finding === undefined) throw new Error(`no finding for ${command}`);
    return finding;
  };

  test("a catastrophic finding takes the protected-path title", () => {
    expect(titleFor(at("rm -rf /"))).toBe(RM_CATASTROPHIC_TITLE);
  });

  test("a blocking finding takes its first git operation other than a force push", () => {
    expect(titleFor(at("git stash"))).toBe("git stash");
    expect(titleFor(at("git push --force origin main && git clean -fd"))).toBe("git clean");
    expect(titleFor(at("git commit --no-verify -m x"))).toBe("git commit --no-verify");
  });

  test("a blocking force push takes the default-branch title", () => {
    expect(titleFor(at("git push --force origin main"))).toBe(FORCE_PUSH_TITLE);
  });

  test("an advisory finding takes its first git operation, else recursive removal", () => {
    expect(titleFor(at("git push --force origin dev"))).toBe("force push to dev");
    expect(titleFor(at("git push -f"))).toBe(gitTitle("push --force"));
    expect(titleFor(at("rm -rf build/cache"))).toBe(RM_TITLE);
  });
});
