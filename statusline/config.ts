export type Env = Record<string, string | undefined>;

export interface Config {
  barWidth: number;
  warnPercent: number;
  critPercent: number;
  cacheTtlSeconds: number;
  gitTimeoutMs: number;
}

function envInt(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim() ?? "";
  return /^[+-]?\d+$/.test(raw) ? Number(raw) : fallback;
}

export function readConfig(env: Env): Config {
  return {
    barWidth: envInt(env, "CLAUDE_STATUSLINE_BAR_WIDTH", 20),
    warnPercent: envInt(env, "CLAUDE_STATUSLINE_THRESHOLD_WARN", 60),
    critPercent: envInt(env, "CLAUDE_STATUSLINE_THRESHOLD_CRIT", 85),
    cacheTtlSeconds: envInt(env, "CLAUDE_STATUSLINE_CACHE_TTL", 5),
    gitTimeoutMs: envInt(env, "CLAUDE_STATUSLINE_GIT_TIMEOUT", 3) * 1000,
  };
}
