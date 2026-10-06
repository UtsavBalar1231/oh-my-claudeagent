import { planTasks } from "../src/core/checkboxes.ts";
import { isHookDisabled } from "../src/core/kill-switch.ts";
import type { Features } from "./dispatch.ts";
import { boundPlanOf, type Host } from "./host.ts";

// The summarizer needs the next steps, not the whole plan; the file keeps the rest.
const MAX_OPEN_TASKS = 10;

async function planInstructions(host: Host): Promise<string | undefined> {
  const plan = await boundPlanOf(host);
  if (plan === undefined || !(await host.fs.exists(plan.path))) return undefined;
  const open = planTasks(await host.fs.read(plan.path)).flatMap((task) => (task.checked ? [] : [`- ${task.number}. ${task.label}`]));
  const more = open.length - MAX_OPEN_TASKS;
  return [
    `Keep OMCA's active plan in the summary: ${plan.name} (${plan.path}).`,
    open.length === 0 ? "Every numbered task is checked." : "Open tasks:",
    ...open.slice(0, MAX_OPEN_TASKS),
    ...(more > 0 ? [`- and ${more} more in the plan file`] : []),
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
