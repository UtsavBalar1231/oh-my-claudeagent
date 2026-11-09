import { TASK_LIST_COMMAND } from "./run-line.ts";

export type NextActionKind = "log-evidence" | "task-list";

export type NextAction = { kind: NextActionKind; label: string; prompt: string };

export type ActionFacts = { verification: { command: string; isLogged: boolean } | null; isRunOpen: boolean };

export function nextActions({ verification, isRunOpen }: ActionFacts): NextAction[] {
  return [
    ...(verification === null || verification.isLogged ? [] : [{ kind: "log-evidence" as const, label: "Log evidence", prompt: `Log evidence for \`${verification.command}\` with evidence_log` }]),
    ...(isRunOpen ? [{ kind: "task-list" as const, label: "Task list", prompt: TASK_LIST_COMMAND }] : []),
  ];
}
