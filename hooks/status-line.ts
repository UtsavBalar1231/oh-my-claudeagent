import { isHookDisabled } from "../src/core/kill-switch.ts";
import { branchOfPorcelainV2, type GitInfo, NO_REPO, parsePorcelainV2, type Payload, render } from "../src/core/status-line.ts";
import type { Features } from "./dispatch.ts";
import { type Host, sessionOf } from "./host.ts";

const GIT_TTL_MS = 5_000;
const GIT_TIMEOUT_MS = 3_000;
const LIMIT_KINDS = new Set(["five_hour", "seven_day", "spend_limit"]);
const MODEL_ID = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/;

/** `claude-opus-5-5` as the settings command's payload names it, `Opus 5.5`; any other name as given. */
export function modelName(model: string): string {
  const [, family, major, minor] = MODEL_ID.exec(model) ?? [];
  if (family === undefined || major === undefined) return model;
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor === undefined ? "" : `.${minor}`}`;
}

let effort: string | undefined;
let invalidatedAt = Number.NEGATIVE_INFINITY;
// An animating mascot redraws every OMCA site each frame, so a line drawn under a second ago is
// reused at the same size; a turn's step or end clears it.
const REUSE_MS = 1_000;
let drawn: { at: number; columns: number; maxRows: number; text: string } | undefined;
let cached: { root: string; at: number; info: Promise<GitInfo> } | undefined;

async function readGit(host: Host, root: string, now: number): Promise<GitInfo> {
  const run = (argv: string[]) =>
    host.process.run(["git", "-C", root, ...argv], { env: { LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" }, timeoutMs: GIT_TIMEOUT_MS });
  try {
    const [status, remote] = await Promise.all([run(["status", "--porcelain=v2", "--branch", "-u"]), run(["remote", "get-url", "origin"]).catch(() => undefined)]);
    if (status.exitCode !== 0) return NO_REPO;
    return {
      repo: true,
      branch: branchOfPorcelainV2(status.stdout),
      ...parsePorcelainV2(status.stdout),
      remote: remote?.exitCode === 0 ? remote.stdout.trim() : "",
      remoteFetchedAt: now / 1000,
    };
  } catch {
    return NO_REPO;
  }
}

function gitOf(host: Host, root: string, now: number): Promise<GitInfo> {
  if (cached === undefined || cached.root !== root || now - cached.at >= GIT_TTL_MS) cached = { root, at: now, info: readGit(host, root, now) };
  return cached.info;
}

async function payloadOf(host: Host, root: string, now: number, mainAgent: unknown): Promise<Payload> {
  const [usage, model, cwd, info] = await Promise.all([host.session.usage(), host.session.model(), host.session.cwd(), host.session.info()]);
  const { context, cost, rateLimits } = usage;
  const agent = info.agentType ?? (typeof mainAgent === "string" && mainAgent !== "" ? mainAgent : undefined);
  const limits: NonNullable<Payload["rate_limits"]> = {};
  for (const { kind, percentUsed, resetsAt } of rateLimits) {
    if (!LIMIT_KINDS.has(kind)) continue;
    const resets = resetsAt === undefined ? Number.NaN : Date.parse(resetsAt);
    limits[kind as "five_hour" | "seven_day" | "spend_limit"] = { used_percentage: percentUsed, ...(Number.isNaN(resets) ? {} : { resets_at: resets / 1000 }) };
  }
  return {
    model: { display_name: modelName(model) },
    cwd,
    workspace: { project_dir: root },
    context_window: { context_window_size: context.window, ...(context.percent === undefined ? {} : { used_percentage: context.percent }) },
    cost: { ...(cost === undefined ? {} : { total_cost_usd: cost.usd }), total_duration_ms: now - usage.startedAt },
    rate_limits: limits,
    ...(effort === undefined ? {} : { effort: { level: effort } }),
    ...(agent === undefined ? {} : { agent: { name: agent } }),
  };
}

export const statusLine: Features = {
  "session.start": {
    pre() {
      effort = undefined;
      cached = undefined;
      drawn = undefined;
      invalidatedAt = Number.NEGATIVE_INFINITY;
      return undefined;
    },
  },
  "turn.step": {
    pre(_host, e) {
      if (e.agentId === undefined && typeof e.effort === "string") effort = e.effort;
      return undefined;
    },
    // A redraw re-runs every OMCA site on screen, so a long turn refreshes the line at the settings
    // command's cadence rather than on each model request.
    async post(host, e) {
      if (e.agentId !== undefined) return undefined;
      const now = await host.clock.now();
      if (now - invalidatedAt < GIT_TTL_MS) return undefined;
      invalidatedAt = now;
      drawn = undefined;
      host.ui.invalidate();
      return undefined;
    },
  },
  "turn.complete": {
    post(host, e) {
      if (e.agentId !== undefined) return undefined;
      drawn = undefined;
      host.ui.invalidate();
      return undefined;
    },
  },
  "ui.render StatusLine": {
    async pre(host, e) {
      const { isManaged, text, maxRows, columns } = e.props;
      if (!host.options.statusLine || isManaged || text !== null || maxRows === 0) return undefined;
      const now = await host.clock.now();
      if (drawn !== undefined && now - drawn.at < REUSE_MS && drawn.columns === columns && drawn.maxRows === maxRows) {
        return { event: { ...e, props: { ...e.props, text: drawn.text } } };
      }
      const { disabledHooks, glyphTier } = await sessionOf(host);
      if (isHookDisabled(disabledHooks, "status-line")) return undefined;
      const settings = await host.settings.read();
      if (settings["statusLine"] !== undefined) return undefined;
      const root = await host.session.root();
      const [payload, git] = await Promise.all([payloadOf(host, root, now, settings["agent"]), gitOf(host, root, now)]);
      drawn = { at: now, columns, maxRows, text: render(payload, git, { COLUMNS: String(columns), OMCA_GLYPHS: glyphTier }, new Date(now), maxRows) };
      return { event: { ...e, props: { ...e.props, text: drawn.text } } };
    },
  },
};
