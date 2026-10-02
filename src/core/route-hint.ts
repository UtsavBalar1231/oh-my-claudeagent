export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type Effort = (typeof EFFORTS)[number];

export type RouteHint = {
  prompt: string;
  effort: Effort | null;
  ignored: readonly string[];
};

const HINT_LINE = /^\s*\[omca-route((?:\s+[^\s=\]]+=[^\s=\]]+)*)\s*\]\s*$/;

function isEffort(value: string | undefined): value is Effort {
  return (EFFORTS as readonly (string | undefined)[]).includes(value);
}

export function parseRouteHint(prompt: string): RouteHint | undefined {
  const end = prompt.indexOf("\n");
  const fields = HINT_LINE.exec(end === -1 ? prompt : prompt.slice(0, end))?.[1];
  if (fields === undefined) return undefined;
  let effort: Effort | null = null;
  const ignored: string[] = [];
  for (const field of fields.split(/\s+/).filter(Boolean)) {
    const [key, value] = field.split("=");
    if (key === "effort" && isEffort(value)) effort = value;
    else ignored.push(field);
  }
  return { prompt: end === -1 ? "" : prompt.slice(end + 1), effort, ignored };
}
