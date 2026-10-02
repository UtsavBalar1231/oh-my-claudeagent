import type { EventResult } from "claude-code";
import { type Context, classify, type GitFinding, type Reviewable, reasonFor } from "../src/core/destructive.ts";
import { isHookDisabled } from "../src/core/kill-switch.ts";
import { homeDir, joinPath, toPosix } from "../src/core/path.ts";
import { homeRest, platformOf } from "../src/core/targets.ts";
import { displayWidth, fitEnd, fitMiddle, type Glyphs, glyphs, isAsciiRequested } from "../src/core/ui-kit.ts";
import type { Features } from "./dispatch.ts";
import type { Host } from "./host.ts";

const RUN = "Run it";
const REFUSE = "Refuse";
// The AskUserQuestion dialog's text column on an 80-column terminal, the narrowest supported:
// its left rule takes 2 of the 80 (measured on 2.1.287).
const WIDTH = 78;
const LIMIT = 20;
const COMMAND_LINES = 3;
const GIT_TIMEOUT_MS = 5000;
// A rejected `$` call reads `<plugin>: $.<noun>.<verb>: <cause>`; the dialog has room for the cause.
const ENGINE_PREFIX = /^[\w-]+: \$\.[\w.]+: /;

const deny = (reason: string): { answer: EventResult<"tool.check"> } => ({ answer: { decision: "deny", reason } });

const commandOf = (input: unknown): string =>
  typeof input === "object" && input !== null && "command" in input && typeof input.command === "string"
    ? input.command
    : "";

const capped = (lines: readonly string[], noun: string): string[] =>
  lines.length > LIMIT ? [...lines.slice(0, LIMIT), `and ${lines.length - LIMIT} more ${noun}`] : [...lines];

const indent = (lines: readonly string[]): string[] => lines.map((line) => `  ${line}`);

async function git(host: Host, argv: readonly string[]): Promise<string[]> {
  const { exitCode, stdout, stderr } = await host.process.run(["git", ...argv], { timeoutMs: GIT_TIMEOUT_MS });
  if (exitCode !== 0) throw new Error(stderr.split("\n")[0]?.trim() || `git ${argv[0]} exited ${exitCode}`);
  return stdout.split("\n").filter((line) => line.trim() !== "");
}

function resolved(target: string, ctx: Context): string | undefined {
  const platform = platformOf(ctx);
  const rest = homeRest(target);
  if (rest !== undefined) return ctx.home === undefined ? undefined : joinPath(platform, ctx.home, rest);
  if (/[$`*?[~%]/.test(target)) return undefined;
  return toPosix(platform, target);
}

async function kindOf(host: Host, target: string, ctx: Context): Promise<string> {
  const path = resolved(target, ctx);
  if (path === undefined) return "not expanded";
  if (!(await host.fs.exists(path))) return "not found";
  const stat = await host.fs.stat(path);
  if (stat.isLink) return "link";
  if (stat.kind === "dir") {
    const count = (await host.fs.list(path)).length;
    return `dir, ${count} ${count === 1 ? "entry" : "entries"}`;
  }
  return stat.kind;
}

async function removalLines(host: Host, targets: readonly string[], g: Glyphs, ctx: Context): Promise<string[]> {
  if (targets.length === 0) return ["It names no target."];
  const shown = targets.slice(0, LIMIT);
  const kinds = await Promise.all(shown.map((target) => kindOf(host, target, ctx)));
  const kindWidth = Math.max(...kinds.map(displayWidth));
  const nameWidth = Math.min(Math.max(...shown.map(displayWidth)), WIDTH - 4 - kindWidth);
  const rows = shown.map((target, i) => {
    const name = fitMiddle(target, nameWidth, g.ellipsis);
    return `${name}${" ".repeat(nameWidth - displayWidth(name))}  ${kinds[i]}`;
  });
  const more = targets.length > LIMIT ? [`and ${targets.length - LIMIT} more`] : [];
  return ["It would remove:", ...indent([...rows, ...more])];
}

const TREE_EFFECT: Record<Exclude<GitFinding["operation"], "reset --hard" | "push --force">, string> = {
  stash: "git stash moves uncommitted changes out of the working tree.",
  clean: "git clean deletes untracked files.",
  restore: "git restore discards changes to the files it names.",
  "rm -r": "git rm -r deletes tracked files from the working tree.",
  "checkout --": "git checkout -- discards changes to the paths it names.",
};

async function resetLines(host: Host): Promise<string[]> {
  const changed = (await git(host, ["status", "--porcelain"])).filter((line) => !line.startsWith("??"));
  if (changed.length === 0) return ["git reset --hard: no uncommitted changes to tracked files."];
  const stat = await git(host, ["diff", `--stat=${WIDTH - 2}`, "HEAD"]);
  return [
    `git reset --hard discards ${changed.length} uncommitted ${changed.length === 1 ? "change" : "changes"}:`,
    ...indent([...capped(stat.slice(0, -1), "files"), ...stat.slice(-1)]),
  ];
}

async function pushLines(host: Host, push: GitFinding): Promise<string[]> {
  const ref =
    push.remote === undefined
      ? "@{push}"
      : `${push.remote}/${push.branch ?? (await git(host, ["rev-parse", "--abbrev-ref", "HEAD"]))[0]}`;
  const lost = await git(host, ["log", "--oneline", ref, "--not", "HEAD"]);
  if (lost.length === 0) return [`git push --force: ${ref} has no commits missing from HEAD.`];
  const noun = lost.length === 1 ? "commit" : "commits";
  return [`git push --force drops ${lost.length} ${noun} from ${ref}:`, ...indent(capped(lost, "commits"))];
}

const gitLines = (host: Host, finding: GitFinding): Promise<string[]> | string[] => {
  switch (finding.operation) {
    case "reset --hard":
      return resetLines(host);
    case "push --force":
      return pushLines(host, finding);
    default:
      return [TREE_EFFECT[finding.operation]];
  }
};

async function gathered(gather: () => Promise<string[]> | string[], g: Glyphs): Promise<string[]> {
  try {
    return await gather();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`${g.warn} Could not check what it would touch: ${message.replace(ENGINE_PREFIX, "")}`];
  }
}

async function question(host: Host, command: string, finding: Reviewable, g: Glyphs, ctx: Context): Promise<string> {
  const commandLines = command.trim().split("\n");
  const shownCommand =
    commandLines.length > COMMAND_LINES
      ? [...commandLines.slice(0, COMMAND_LINES), `and ${commandLines.length - COMMAND_LINES} more lines`]
      : commandLines;
  const targets = finding.removals.flatMap((removal) => removal.targets);
  const sections = await Promise.all([
    ...(finding.removals.length > 0 ? [gathered(() => removalLines(host, targets, g, ctx), g)] : []),
    ...finding.git.map((operation) => gathered(() => gitLines(host, operation), g)),
  ]);
  const lines = ["OMCA held this command for your review:", ...indent(shownCommand), ...sections.flat(), "Run it?"];
  return lines.map((line) => fitEnd(line, WIDTH, g.ellipsis)).join("\n");
}

const shellOf = (tool: string): Context["shell"] => (tool === "PowerShell" ? "powershell" : "bash");

async function contextOf(host: Host, shell: Context["shell"]): Promise<Context> {
  const [HOME, USERPROFILE, HOMEDRIVE, HOMEPATH, cwd, root] = await Promise.all([
    host.env.HOME(),
    host.env.USERPROFILE(),
    host.env.HOMEDRIVE(),
    host.env.HOMEPATH(),
    host.session.cwd().catch(() => undefined),
    host.session.root().catch(() => undefined),
  ]);
  const home = homeDir({ HOME, USERPROFILE, HOMEDRIVE, HOMEPATH });
  return {
    shell,
    ...(home !== undefined && { home }),
    ...(cwd !== undefined && { cwd }),
    ...(root !== undefined && { root }),
  };
}

export const bashGuard: Features = {
  "tool.check": {
    pre: async (host, e) => {
      const command = commandOf(e.input);
      const shell = shellOf(e.tool);
      const first = classify(command, { shell });
      if (first === undefined) return undefined;
      if (first.kind === "catastrophic") return deny(reasonFor(first));
      const ctx = await contextOf(host, shell);
      const finding = classify(command, ctx);
      if (finding === undefined) return undefined;
      if (finding.kind === "catastrophic") return deny(reasonFor(finding));
      if (isHookDisabled(await host.env.OMCA_DISABLED_HOOKS(), "bash-guard")) return undefined;
      const reason = reasonFor(finding);
      const canAsk = host.options.guardMode === "dialog" && (await host.session.surfaces()).length > 0;
      if (!canAsk) return finding.kind === "blocking" ? deny(reason) : undefined;
      const g = glyphs(isAsciiRequested(await host.env.OMCA_ASCII()));
      const text = await question(host, command, finding, g, ctx);
      const answer = await host.ui.ask(text, { header: "OMCA guard", options: [REFUSE, RUN] }).catch(() => undefined);
      return answer === RUN ? undefined : deny(reason);
    },
  },
};
