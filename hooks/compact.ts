import { resolveBoundPlan } from "../src/core/boulder.ts";
import { isHookDisabled } from "../src/core/kill-switch.ts";
import { BOULDER } from "../src/core/omca-paths.ts";
import { parsePlan } from "../src/core/plan-reader.ts";
import type { Features } from "./dispatch.ts";
import type { Host } from "./host.ts";

// The summarizer needs the next steps, not the whole plan; the file keeps the rest.
const MAX_OPEN_TASKS = 10;

async function planInstructions(host: Host): Promise<string | undefined> {
  const [root, sessionId] = await Promise.all([host.session.root(), host.session.id()]);
  const registry = `${root}/${BOULDER}`;
  if (!(await host.fs.exists(registry))) return undefined;
  const plan = resolveBoundPlan(JSON.parse(await host.fs.read(registry)), sessionId, true);
  if (!("plan_name" in plan) || !(await host.fs.exists(plan.active_plan))) return undefined;
  const open = parsePlan(await host.fs.read(plan.active_plan)).pages.flatMap((page) =>
    page.task !== undefined && !page.task.done ? [`- ${page.title}`] : [],
  );
  const more = open.length - MAX_OPEN_TASKS;
  return [
    `Keep OMCA's active plan in the summary: ${plan.plan_name} (${plan.active_plan}).`,
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
