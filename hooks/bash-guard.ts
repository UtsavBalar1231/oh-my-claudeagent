import type { EventResult } from "claude-code";
import { type Context, classify, type Finding } from "../src/core/destructive.ts";
import { GIT_ENV, type GitAnswer, gitQueries, gitVerdict } from "../src/core/git-state.ts";
import { isHookDisabled } from "../src/core/kill-switch.ts";
import type { Features } from "./dispatch.ts";
import { type Host, reason, sessionOf } from "./host.ts";

const GIT_TIMEOUT_MS = 5000;

const deny = (reason: string): { answer: EventResult<"tool.check"> } => ({ answer: { decision: "deny", reason } });

const commandOf = (input: unknown): string =>
  typeof input === "object" && input !== null && "command" in input && typeof input.command === "string"
    ? input.command
    : "";

const shellOf = (tool: string): Context["shell"] => (tool === "PowerShell" ? "powershell" : "bash");

const run = (host: Host, argv: readonly string[]): Promise<GitAnswer> =>
  host.process.run(argv, { timeoutMs: GIT_TIMEOUT_MS, env: GIT_ENV }).then(
    ({ exitCode, stdout, stderr }) => ({ exitCode, stdout, stderr }),
    (error: unknown) => ({ error: reason(error) }),
  );

const symbolicRef = (host: Host, name: string): Promise<string | undefined> =>
  run(host, ["git", "symbolic-ref", "--quiet", "--short", name]).then((answer) =>
    "error" in answer || answer.exitCode !== 0 ? undefined : answer.stdout.split("\n")[0]?.trim() || undefined,
  );

// Read from local refs only, so deciding never waits on the network.
async function branchesOf(host: Host): Promise<Pick<Context, "branch" | "defaultBranch">> {
  const [branch, originHead] = await Promise.all([symbolicRef(host, "HEAD"), symbolicRef(host, "refs/remotes/origin/HEAD")]);
  return {
    ...(branch !== undefined && { branch }),
    ...(originHead !== undefined && { defaultBranch: originHead.replace(/^origin\//, "") }),
  };
}

async function contextOf(host: Host, shell: Context["shell"], isPush: boolean): Promise<Context> {
  const [home, cwd, root, branches] = await Promise.all([
    sessionOf(host).then(
      (session) => session.home,
      () => "",
    ),
    host.session.cwd().catch(() => undefined),
    host.session.root().catch(() => undefined),
    isPush ? branchesOf(host) : {},
  ]);
  return {
    shell,
    ...(home !== "" && { home }),
    ...(cwd !== undefined && { cwd }),
    ...(root !== undefined && { root }),
    ...branches,
  };
}

/** The deny reason for the git rules: one denied outright, or a whole-tree operation the repository says would discard work. */
async function gitReason(host: Host, finding: Extract<Finding, { kind: "git" }>): Promise<string | undefined> {
  if (finding.reason !== undefined) return finding.reason;
  const queries = gitQueries(finding.checks);
  const answers = await Promise.all(queries.map((query) => (query.argv === undefined ? undefined : run(host, query.argv))));
  return gitVerdict(queries, answers);
}

export const bashGuard: Features = {
  "tool.check": {
    pre: async (host, e) => {
      const command = commandOf(e.input);
      const shell = shellOf(e.tool);
      const first = classify(command, { shell });
      if (first === undefined) return undefined;
      if (first.kind === "catastrophic") return deny(first.reason);
      // A disabled guard still classifies with the context, because the catastrophic deny has no switch.
      const isDisabled = isHookDisabled(await host.env.OMCA_DISABLED_HOOKS(), "bash-guard");
      const ctx = await contextOf(host, shell, !isDisabled && first.kind === "git" && first.isForcePush);
      const finding = classify(command, ctx);
      if (finding?.kind === "catastrophic") return deny(finding.reason);
      if (isDisabled || finding?.kind !== "git") return undefined;
      const refusal = await gitReason(host, finding);
      return refusal === undefined ? undefined : deny(refusal);
    },
  },
};
