import { planTasks, type TaskState } from "../src/core/checkboxes.ts";
import { isHookDisabled } from "../src/core/kill-switch.ts";
import type { Features } from "./dispatch.ts";
import { boundPlanOf, type Host } from "./host.ts";

// The summarizer needs the next steps, not the whole plan; the file keeps the rest.
const MAX_LISTED_TASKS = 10;

const section = (title: string, lines: readonly string[]): string[] => {
  const more = lines.length - MAX_LISTED_TASKS;
  return lines.length === 0 ? [] : [title, ...lines.slice(0, MAX_LISTED_TASKS), ...(more > 0 ? [`- and ${more} more in the plan file`] : [])];
};

async function planInstructions(host: Host): Promise<string | undefined> {
  const plan = await boundPlanOf(host);
  if (plan === undefined || !(await host.fs.exists(plan.path))) return undefined;
  const tasks = planTasks(await host.fs.read(plan.path));
  const lines = (state: TaskState) => tasks.flatMap((task) => (task.state === state ? [`- ${task.number}. ${task.label}`] : []));
  const open = lines("open");
  const blocked = lines("blocked");
  return [
    `Keep OMCA's active plan in the summary: ${plan.name} (${plan.path}).`,
    ...(open.length === 0 && blocked.length === 0 ? ["Every numbered task is checked."] : []),
    ...section("Open tasks:", open),
    ...section("Blocked tasks, not done and not to be run:", blocked),
  ].join("\n");
}

export const compact: Features = {
  "session.compact": {
    pre: async (host, e) => {
      if (e.agentId !== undefined || isHookDisabled(await host.env.OMCA_DISABLED_HOOKS(), "compact")) return undefined;
      const plan = await planInstructions(host);
      if (plan === undefined) return undefined;
      return { event: { ...e, instructions: e.instructions ? `${e.instructions}\n\n${plan}` : plan } };
    },
  },
};
