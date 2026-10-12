import type { Features } from "./dispatch.ts";

export const spinner: Features = {
  "ui.render Spinner": {
    pre: async (host, e) => {
      if (e.surface !== "terminal") return undefined;
      const [{ value: snapshot }, { value: agents = {} }] = await Promise.all([host.state.band.get(), host.state.agents.get()]);
      if (agents[e.requestId] !== undefined) return undefined;
      const plan = snapshot?.plan;
      const running = Object.values(agents).filter((agent) => agent.status === "running" && !agent.teammate).length;
      const parts = [
        ...(plan === null || plan === undefined || plan.done >= plan.total ? [] : [`task ${plan.done + 1}/${plan.total}`]),
        ...(running === 0 ? [] : [`${running} ${running === 1 ? "agent" : "agents"}`]),
      ];
      if (parts.length === 0) return undefined;
      return { event: { ...e, props: { ...e.props, suffix: ["…", ...parts].join(" · ") } } };
    },
  },
};
