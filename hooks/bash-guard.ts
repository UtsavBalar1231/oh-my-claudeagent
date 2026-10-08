import type { EventResult } from "claude-code";
import { type Context, classify, type GitFinding, type Reviewable, reasonFor } from "../src/core/destructive.ts";
import { isHookDisabled } from "../src/core/kill-switch.ts";
import { joinPath, toPosix } from "../src/core/path.ts";
import { homeRest, platformOf } from "../src/core/targets.ts";
import { cells, displayWidth, fitEnd, fitMiddle, type Glyphs, glyphs } from "../src/core/ui-kit.ts";
import type { Features } from "./dispatch.ts";
import { type Host, reason, sessionOf } from "./host.ts";

const RUN = "Run it";
const REFUSE = "Refuse";
// The AskUserQuestion dialog's text column on an 80-column terminal, the narrowest supported:
// its left rule takes 2 of the 80 (measured).
const WIDTH = 78;
const COMMAND_ROWS = 4;
// The dialog's text rows on a 24-row terminal: the engine's frame and the Refuse and Run options take the other 12 (measured).
const BODY_ROWS = 12;
const GIT_TIMEOUT_MS = 5000;

const deny = (reason: string): { answer: EventResult<"tool.check"> } => ({ answer: { decision: "deny", reason } });

const commandOf = (input: unknown): string =>
  typeof input === "object" && input !== null && "command" in input && typeof input.command === "string"
    ? input.command
    : "";

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

// Breaks at the last space that fits, or mid-word when a row has none, so every character up to the row cap is kept.
function commandRows(command: string, g: Glyphs): string[] {
  const rows: string[] = [];
  let rest = [...command.trim()];
  while (rest.length > 0 && rows.length < COMMAND_ROWS) {
    let end = 0;
    let used = 0;
    let space = 0;
    for (const char of rest) {
      used += cells(char.codePointAt(0) ?? 0);
      if (char === "\n" || used > WIDTH - 2) break;
      if (char === " ") space = end;
      end += 1;
    }
    const cut = end < rest.length && rest[end] !== "\n" && space > 0 ? space : end;
    const row = rest.slice(0, cut).join("").trimEnd();
    if (row !== "") rows.push(row);
    rest = rest.slice(cut);
    if (rest[0] === "\n" || rest[0] === " ") rest = rest.slice(1);
  }
  const left = rest.length;
  return left === 0 ? rows : [...rows, `${g.ellipsis} ${left} more ${left === 1 ? "character" : "characters"}`];
}

type Section = {
  head: string[];
  total: number;
  items: (count: number) => string[];
  foot: string[];
  noun: string;
};

const note = (...head: string[]): Section => ({ head, total: 0, items: () => [], foot: [], noun: "" });

async function removalSection(host: Host, targets: readonly string[], g: Glyphs, ctx: Context): Promise<Section> {
  if (targets.length === 0) return note("It names no target.");
  const pool = targets.slice(0, BODY_ROWS);
  const kinds = await Promise.all(pool.map((target) => kindOf(host, target, ctx)));
  const items = (count: number): string[] => {
    const shown = pool.slice(0, count);
    const kindWidth = Math.max(...kinds.slice(0, count).map(displayWidth));
    const nameWidth = Math.min(Math.max(...shown.map(displayWidth)), WIDTH - 4 - kindWidth);
    return shown.map((target, i) => {
      const name = fitMiddle(target, nameWidth, g.ellipsis);
      return `${name}${" ".repeat(nameWidth - displayWidth(name))}  ${kinds[i]}`;
    });
  };
  return { head: ["It would remove:"], total: targets.length, items, foot: [], noun: "" };
}

const TREE_EFFECT: Record<Exclude<GitFinding["operation"], "reset --hard" | "push --force">, string> = {
  stash: "git stash moves uncommitted changes out of the working tree.",
  clean: "git clean deletes untracked files.",
  restore: "git restore discards changes to the files it names.",
  "rm -r": "git rm -r deletes tracked files from the working tree.",
  "checkout --": "git checkout -- discards changes to the paths it names.",
  "commit --no-verify": "git commit --no-verify skips the repository's pre-commit and commit-msg hooks.",
};

async function resetSection(host: Host): Promise<Section> {
  const changed = (await git(host, ["status", "--porcelain"])).filter((line) => !line.startsWith("??"));
  if (changed.length === 0) return note("git reset --hard: no uncommitted changes to tracked files.");
  const stat = await git(host, ["diff", `--stat=${WIDTH - 2}`, "HEAD"]);
  return {
    head: [`git reset --hard discards ${changed.length} uncommitted ${changed.length === 1 ? "change" : "changes"}:`],
    total: Math.max(0, stat.length - 1),
    items: (count) => stat.slice(0, count),
    foot: stat.slice(-1),
    noun: "files",
  };
}

async function pushSection(host: Host, push: GitFinding): Promise<Section> {
  const ref =
    push.remote === undefined
      ? "@{push}"
      : `${push.remote}/${push.branch ?? (await git(host, ["rev-parse", "--abbrev-ref", "HEAD"]))[0]}`;
  const lost = await git(host, ["log", "--oneline", ref, "--not", "HEAD"]);
  if (lost.length === 0) return note(`git push --force: ${ref} has no commits missing from HEAD.`);
  const noun = lost.length === 1 ? "commit" : "commits";
  return {
    head: [`git push --force drops ${lost.length} ${noun} from ${ref}:`],
    total: lost.length,
    items: (count) => lost.slice(0, count),
    foot: [],
    noun: "commits",
  };
}

const gitSection = (host: Host, finding: GitFinding): Promise<Section> | Section => {
  switch (finding.operation) {
    case "reset --hard":
      return resetSection(host);
    case "push --force":
      return pushSection(host, finding);
    default:
      return note(TREE_EFFECT[finding.operation]);
  }
};

async function gathered(gather: () => Promise<Section> | Section, g: Glyphs): Promise<Section> {
  try {
    return await gather();
  } catch (error) {
    return note(`${g.warn} Could not check what it would touch: ${reason(error)}`);
  }
}

// A list that does not fit keeps its first entries and ends in `and N more`; each cut list keeps at least one entry.
function shareRows(sections: readonly Section[], rows: number): number[] {
  const wanted = sections.reduce((sum, section) => sum + section.total, 0);
  return sections.map((section) => {
    const share = Math.floor((rows * section.total) / Math.max(1, wanted));
    return wanted <= rows || section.total <= share ? section.total : Math.max(2, share);
  });
}

function drawn(section: Section, rows: number): string[] {
  const shown = section.total <= rows ? section.total : rows - 1;
  const more = section.total > shown ? [["and", section.total - shown, "more", section.noun].filter(Boolean).join(" ")] : [];
  return [...section.head, ...indent([...section.items(shown), ...more, ...section.foot])];
}

async function question(host: Host, command: string, finding: Reviewable, g: Glyphs, ctx: Context): Promise<string> {
  const shownCommand = commandRows(command, g);
  const targets = finding.removals.flatMap((removal) => removal.targets);
  const sections = await Promise.all([
    ...(finding.removals.length > 0 ? [gathered(() => removalSection(host, targets, g, ctx), g)] : []),
    ...finding.git.map((operation) => gathered(() => gitSection(host, operation), g)),
  ]);
  const fixed = sections.reduce((sum, section) => sum + section.head.length + section.foot.length, 0);
  const rows = shareRows(sections, BODY_ROWS - 2 - shownCommand.length - fixed);
  const lines = [
    "OMCA held this command for your review:",
    ...indent(shownCommand),
    ...sections.flatMap((section, i) => drawn(section, rows[i] ?? 0)),
    "Run it?",
  ];
  return lines.map((line) => fitEnd(line, WIDTH, g.ellipsis)).join("\n");
}

const shellOf = (tool: string): Context["shell"] => (tool === "PowerShell" ? "powershell" : "bash");

const symbolicRef = (host: Host, name: string): Promise<string | undefined> =>
  git(host, ["symbolic-ref", "--quiet", "--short", name]).then(
    ([line]) => line,
    () => undefined,
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

export const bashGuard: Features = {
  "tool.check": {
    pre: async (host, e) => {
      const command = commandOf(e.input);
      const shell = shellOf(e.tool);
      const first = classify(command, { shell });
      if (first === undefined) return undefined;
      if (first.kind === "catastrophic") return deny(reasonFor(first));
      // A disabled guard still classifies with the context, because the catastrophic deny has no switch.
      const isDisabled = isHookDisabled(await host.env.OMCA_DISABLED_HOOKS(), "bash-guard");
      const isPush = !isDisabled && first.git.some((finding) => finding.operation === "push --force");
      const ctx = await contextOf(host, shell, isPush);
      const finding = classify(command, ctx);
      if (finding === undefined) return undefined;
      if (finding.kind === "catastrophic") return deny(reasonFor(finding));
      if (isDisabled) return undefined;
      const refusal = reasonFor(finding);
      const canAsk = host.options.guardMode === "dialog" && (await host.session.surfaces()).length > 0;
      if (!canAsk) return finding.kind === "blocking" ? deny(refusal) : undefined;
      const g = glyphs((await sessionOf(host)).glyphTier);
      const text = await question(host, command, finding, g, ctx);
      const answer = await host.ui.ask(text, { header: "OMCA guard", options: [REFUSE, RUN] }).catch(() => undefined);
      return answer === RUN ? undefined : deny(refusal);
    },
  },
};
