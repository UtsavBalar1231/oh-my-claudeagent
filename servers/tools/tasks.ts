import { formatTask, formatTasks, type NativeTask } from "../../src/core/native-tasks.ts";
import { latestSessionId } from "../hooks/session-state.ts";
import { readTasks } from "../hooks/status-file.ts";
import type { Tool } from "../omca.ts";
import { type Args, argReader, rootOf, WORKING_DIRECTORY } from "./args.ts";

const tasksFor = (args: Args, tool: string): NativeTask[] =>
  readTasks(rootOf(argReader(args, tool).string("working_directory", "")), latestSessionId() ?? process.env.CLAUDE_CODE_SESSION_ID ?? "");

function taskList(args: Args): string {
  return formatTasks(tasksFor(args, "task_list"));
}

function taskGet(args: Args): string {
  const taskId = argReader(args, "task_get").string("taskId");
  const tasks = tasksFor(args, "task_get");
  const task = tasks.find(({ id }) => id === taskId);
  if (task === undefined) throw new Error(`Task #${taskId} is not on the list`);
  return formatTask(task, tasks);
}

export const tools: Tool[] = [
  {
    name: "task_list",
    description:
      "Read Claude Code's task list from any agent: each task's id, status and subject under its run, which task is the run's final one, the open tasks it waits on, and why a task was closed as blocked. A task completed or closed as blocked holds nothing back. A subagent in the background has no TaskList, and TaskList leaves out the run, final and blocked marks. Read-only: the main session changes the list.",
    inputSchema: { type: "object", properties: { working_directory: WORKING_DIRECTORY } },
    annotations: { title: "Read the task list", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    _meta: { "anthropic/searchHint": "read a run's tasks from any agent, background subagents included" },
    call: taskList,
  },
  {
    name: "task_get",
    description: "Read one task of Claude Code's task list as JSON, from any agent: its subject, description, status, owner, links, run, final and blocked marks, and other metadata. blockedBy names every link and openBlockers the ones still holding it: a task completed or closed as blocked holds nothing back. A task closed as blocked keeps status pending, with its reason in blockedReason. Read-only: the main session changes the list.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The task's id, as task_list prints it without the #" },
        working_directory: WORKING_DIRECTORY,
      },
      required: ["taskId"],
    },
    annotations: { title: "Read one task", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    _meta: { "anthropic/searchHint": "read one task in full from any agent, background subagents included" },
    call: taskGet,
  },
];
