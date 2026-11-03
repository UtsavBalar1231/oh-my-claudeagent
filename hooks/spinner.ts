import type { Features } from "./dispatch.ts";

export const spinner: Features = {
  "ui.render Spinner": {
    pre: async (host, e) => {
      if (e.surface !== "terminal") return undefined;
      const [{ value: snapshot }, { value: agents = {} }] = await Promise.all([host.state.band.get(), host.state.agents.get()]);
      if (agents[e.requestId] !== undefined) return undefined;
      const plan = snapshot?.plan;
      if (plan === null || plan === undefined) return undefined;
      const closed = plan.done + plan.blocked;
      if (closed >= plan.total) return undefined;
      return { event: { ...e, props: { ...e.props, suffix: `… · task ${closed + 1}/${plan.total}` } } };
    },
  },
};
