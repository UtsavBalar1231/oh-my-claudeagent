import { taskListIdFor } from "../src/core/native-tasks.ts";
import type { Features } from "./dispatch.ts";
import { type Host, reason } from "./host.ts";

/** Whether the model can call the task tools now. A client that cannot say counts as without them. */
export async function hasTaskTools(host: Host): Promise<boolean> {
  try {
    const names = new Set((await host.tool.list()).map((tool) => tool.name));
    return names.has("TaskCreate") && names.has("TaskUpdate");
  } catch (error) {
    host.log(`omca could not list the tools: ${reason(error)}`);
    return false;
  }
}

// A value someone set stays, since it may be an organization's: the session then refuses by name
// rather than overriding it. The named list lets a run outlive `/clear` and a new session. The
// client reads the variable each time it builds the tool list, and under `claude -p` that list
// catches up only after this hook, so presence is judged per turn.
export const taskTools: Features = {
  "session.start": {
    async post(host) {
      const [tools, list] = await Promise.all([host.env.CLAUDE_CODE_ENABLE_TODO_TOOLS(), host.env.CLAUDE_CODE_TASK_LIST_ID()]);
      const answers = await Promise.all([
        ...(tools === undefined || tools === "" ? [host.enableTaskTools()] : []),
        ...(list === undefined || list === "" ? [host.nameTaskList(taskListIdFor(await host.session.root()))] : []),
      ]);
      for (const { deny } of answers) if (deny !== undefined) host.log(`omca could not set up the task list: ${deny}`);
      return undefined;
    },
  },
};
