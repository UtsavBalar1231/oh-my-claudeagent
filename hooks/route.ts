import { parseRouteHint, type Effort } from "../src/core/route-hint.ts";
import type { Features } from "./dispatch.ts";
import { update } from "./host.ts";

const hinted = new Map<string, Effort>();

export const route: Features = {
  "agent.spawn": {
    pre: (host, e) => {
      const hint = parseRouteHint(e.prompt);
      if (hint === undefined) return undefined;
      for (const field of hint.ignored) host.log(`route: ignored unknown hint field ${field}`);
      if (hint.effort !== null) hinted.set(e.tool_use_id, hint.effort);
      return { event: { ...e, prompt: hint.prompt } };
    },
    post: async (host, e, result) => {
      const effort = hinted.get(e.tool_use_id);
      hinted.delete(e.tool_use_id);
      if (effort === undefined || result.agentId === undefined) return undefined;
      const { agentId } = result;
      await update(host.state.routes, (routes) => ({ ...routes, [agentId]: effort }));
      return undefined;
    },
  },
  "turn.step": {
    pre: async (host, e) => {
      if (e.agentId === undefined || e.effort === undefined) return undefined;
      const { value } = await host.state.routes.get();
      const effort = value?.[e.agentId];
      return effort === undefined ? undefined : { event: { ...e, effort } };
    },
  },
};
