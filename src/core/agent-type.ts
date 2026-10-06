const PREFIX = "oh-my-claudeagent:";

export function omcaAgentName(type: string): string | undefined {
  const name = type.startsWith(PREFIX) ? type.slice(PREFIX.length) : type;
  return name === "" || name.includes(":") ? undefined : name;
}
