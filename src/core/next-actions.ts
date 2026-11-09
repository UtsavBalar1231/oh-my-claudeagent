import { TASK_LIST_COMMAND } from "./run-line.ts";

export type NextActionKind = "task-list";

export type NextAction = { kind: NextActionKind; label: string; prompt: string };

export type ActionFacts = { isRunOpen: boolean };

export function nextActions({ isRunOpen }: ActionFacts): NextAction[] {
  return isRunOpen ? [{ kind: "task-list", label: "Task list", prompt: TASK_LIST_COMMAND }] : [];
}
