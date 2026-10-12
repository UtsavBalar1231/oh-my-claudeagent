const PREFIX = "oh-my-claudeagent:";

/** The agent type Claude Code gives a fork, a copy of the loop that spawned it. */
export const FORK = "fork";

export function omcaAgentName(type: string): string | undefined {
  const name = type.startsWith(PREFIX) ? type.slice(PREFIX.length) : type;
  return name === "" || name.includes(":") ? undefined : name;
}

/** The type whose mascot and color an agent wears: a fork wears the agent it copies. */
export const lookOf = (agent: { readonly type: string; readonly forkOf?: string | undefined }): string => agent.forkOf ?? agent.type;
