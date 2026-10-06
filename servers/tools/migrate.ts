import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import { RENAMES } from "../../src/core/agent-names.ts";
import { configDir } from "../../src/core/path.ts";
import { errorCode, isMissing } from "../io.ts";
import type { Tool } from "../omca.ts";
import { argReader, rootOf, WORKING_DIRECTORY } from "./args.ts";

export type Action = { kind: string; from: string; to?: string };
export type Collision = { from: string; to: string; reason: string };
export type Mention = { path: string; reason: string };
export type Migration = { actions: Action[]; collisions: Collision[]; mentions: Mention[] };
export type MigrateOptions = { apply: boolean; mergeIndexes: boolean; root: string; configDir: string; home: string };

const NEW_NAMES = new Map<string, string>([...Object.entries(RENAMES.agents), ...Object.entries(RENAMES.skills)]);
const OLD_NAMES = [...NEW_NAMES.keys()].join("|");
const WORD = "A-Za-z0-9_-";
const MEMORY_DIR = "oh-my-claudeagent-";
const BACKUP = ".bak-omca-migrate";
const MENTION = new RegExp(`(?<![${WORD}])(?:(?:oh-my-claudeagent[:-]|omca-)(?:${OLD_NAMES})|\`(?:${OLD_NAMES})\`)(?![${WORD}])|\\|\\s*(?:${OLD_NAMES})\\s*\\|`);

const idRewriter = (prefix: string) => {
  const pattern = new RegExp(`(?<![${WORD}])${prefix}(${OLD_NAMES})(?![${WORD}])`, "g");
  return (text: string) => text.replace(pattern, (_match, old: string) => `${prefix}${NEW_NAMES.get(old)}`);
};
const rewriteSettings = idRewriter("oh-my-claudeagent:");
const rewriteOpenCode = idRewriter("omca-");

type Kind = "absent" | "dir" | "file" | "symlink";

function kindOf(path: string): Kind {
  try {
    const stat = lstatSync(path);
    return stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : "file";
  } catch (error) {
    if (isMissing(error)) return "absent";
    throw error;
  }
}

const exists = (path: string): boolean => kindOf(path) !== "absent";

function backupPath(path: string): string {
  const base = `${path}${BACKUP}`;
  if (!exists(base)) return base;
  let epoch = Math.floor(Date.now() / 1000);
  while (exists(`${base}.${epoch}`)) epoch++;
  return `${base}.${epoch}`;
}

function replaceFile(path: string, text: string): void {
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  const mode = statSync(path).mode & 0o777;
  try {
    const fd = openSync(temp, "wx", mode);
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(temp, mode);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

const asideName = (name: string, old: string): string => {
  const ext = extname(name);
  return `${name.slice(0, name.length - ext.length)}.from-${old}${ext}`;
};

const lines = (text: string): string[] => text.split(/\r?\n/).map((line) => line.trimEnd());

class Run {
  readonly report: Migration = { actions: [], collisions: [], mentions: [] };
  readonly edited = new Set<string>();
  readonly asides = new Map<string, string>();
  readonly apply: boolean;

  constructor(apply: boolean) {
    this.apply = apply;
  }

  act(kind: string, from: string, to?: string): void {
    this.report.actions.push(to === undefined ? { kind, from } : { kind, from, to });
  }

  move(kind: string, from: string, to: string): void {
    this.act(kind, from, to);
    if (this.apply) renameSync(from, to);
  }

  removeDir(path: string): void {
    this.act("remove-dir", path);
    if (this.apply) rmdirSync(path);
  }

  /** Moves each entry of `src` that `dst` lacks, sets a colliding one aside, and returns how many entries stay in `src`. */
  mergeEntries(src: string, dst: string, old: string): number {
    let remaining = 0;
    for (const name of readdirSync(src).sort()) {
      const from = join(src, name);
      const to = join(dst, name);
      const fromKind = kindOf(from);
      const toKind = kindOf(to);
      if (fromKind === "symlink") {
        this.report.collisions.push({ from, to, reason: "symlink, not moved" });
        remaining++;
      } else if (toKind === "absent") {
        this.move("move", from, to);
      } else if (fromKind === "dir" && toKind === "dir") {
        if (this.mergeEntries(from, to, old) === 0) this.removeDir(from);
        else remaining++;
      } else {
        const aside = join(dst, asideName(name, old));
        const taken = exists(aside);
        this.report.collisions.push({ from, to: aside, reason: taken ? "set-aside name exists, not moved" : "target exists, moved aside" });
        if (taken) {
          remaining++;
        } else {
          this.asides.set(aside, from);
          this.move("move-aside", from, aside);
        }
      }
    }
    return remaining;
  }

  moveMemory(scope: string, old: string, current: string): void {
    const from = join(scope, `${MEMORY_DIR}${old}`);
    const to = join(scope, `${MEMORY_DIR}${current}`);
    const fromKind = kindOf(from);
    if (fromKind === "absent") return;
    if (fromKind !== "dir") {
      this.report.mentions.push({ path: from, reason: `${fromKind === "symlink" ? "symlinked" : "not a directory"}, not followed` });
      return;
    }
    const toKind = kindOf(to);
    if (readdirSync(from).length === 0) this.removeDir(from);
    else if (toKind === "absent") this.move("move-dir", from, to);
    else if (toKind !== "dir") this.report.collisions.push({ from, to, reason: "target is not a directory" });
    else if (this.mergeEntries(from, to, old) === 0) this.removeDir(from);
  }

  mergeIndex(dir: string, old: string): void {
    const fromFile = join(dir, `MEMORY.from-${old}.md`);
    const target = join(dir, "MEMORY.md");
    const source = exists(fromFile) ? fromFile : this.asides.get(fromFile);
    if (source === undefined || kindOf(source) !== "file" || kindOf(target) !== "file") return;
    const targetText = readFileSync(target, "utf8");
    const have = new Set(lines(targetText));
    const wanted = lines(readFileSync(source, "utf8")).filter((line) => line.trim() !== "");
    const missing: string[] = [];
    for (const line of wanted) {
      if (have.has(line)) continue;
      have.add(line);
      missing.push(line);
    }
    if (missing.length > 0) {
      const backup = backupPath(target);
      this.act("backup", target, backup);
      this.act("merge-index", fromFile, target);
      if (this.apply) {
        copyFileSync(target, backup, constants.COPYFILE_EXCL);
        const separator = targetText === "" || targetText.endsWith("\n") ? "" : "\n";
        replaceFile(target, `${targetText}${separator}${missing.join("\n")}\n`);
      }
    }
    if (this.apply) {
      const after = new Set(lines(readFileSync(target, "utf8")));
      if (wanted.some((line) => !after.has(line))) {
        this.report.mentions.push({ path: fromFile, reason: "lines missing from MEMORY.md after the merge, not removed" });
        return;
      }
      unlinkSync(fromFile);
    }
    this.act("remove-file", fromFile);
  }

  rewrite(file: string, rewriter: (text: string) => string): void {
    let real: string;
    let text: string;
    try {
      real = realpathSync(file);
      text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(real));
    } catch (error) {
      if (!isMissing(error)) this.report.mentions.push({ path: file, reason: `unreadable, left untouched: ${errorCode(error) ?? "not UTF-8"}` });
      return;
    }
    const next = rewriter(text);
    if (next === text) return;
    const backup = backupPath(real);
    this.act("backup", real, backup);
    this.act("rewrite", real);
    this.edited.add(real);
    if (!this.apply) return;
    try {
      copyFileSync(real, backup, constants.COPYFILE_EXCL);
      replaceFile(real, next);
    } catch (error) {
      this.report.mentions.push({ path: real, reason: `not rewritten: ${errorCode(error) ?? String(error)}` });
    }
  }

  scanMentions(path: string): void {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return;
    }
    if (MENTION.test(text)) this.report.mentions.push({ path, reason: "names an agent listed in the rename table" });
  }
}

function markdownFiles(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
      const child = join(path, entry.name);
      if (entry.isDirectory()) return markdownFiles(child);
      return entry.isFile() && entry.name.endsWith(".md") ? [child] : [];
    });
  } catch (error) {
    if (isMissing(error) || errorCode(error) === "EACCES") return [];
    throw error;
  }
}

export function migrate({ apply, mergeIndexes, root, configDir: config, home }: MigrateOptions): Migration {
  const run = new Run(apply);
  const scopes = [join(root, ".claude", "agent-memory"), join(root, ".claude", "agent-memory-local"), join(config, "agent-memory")];
  for (const scope of scopes) {
    for (const [old, current] of Object.entries(RENAMES.agents)) {
      run.moveMemory(scope, old, current);
      if (mergeIndexes && kindOf(join(scope, `${MEMORY_DIR}${current}`)) === "dir") run.mergeIndex(join(scope, `${MEMORY_DIR}${current}`), old);
    }
  }

  const xdg = process.env["XDG_CONFIG_HOME"];
  const openCode = join(xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, ".config"), "opencode");
  for (const file of [join(config, "settings.json"), join(root, ".claude", "settings.json"), join(root, ".claude", "settings.local.json")]) {
    run.rewrite(file, rewriteSettings);
  }
  for (const dir of [root, openCode]) {
    for (const name of ["opencode.json", "opencode.jsonc"]) run.rewrite(join(dir, name), rewriteOpenCode);
  }

  const slug = root.replace(/[^A-Za-z0-9]/g, "-");
  const candidates = [
    join(root, "CLAUDE.md"),
    join(root, ".claude", "CLAUDE.md"),
    join(root, "AGENTS.md"),
    join(config, "CLAUDE.md"),
    join(config, "projects", slug, "memory", "MEMORY.md"),
    ...[join(root, ".claude"), config].flatMap((base) => ["agents", "commands", "skills"].flatMap((dir) => markdownFiles(join(base, dir)))),
    ...markdownFiles(join(openCode, "agent")),
  ];
  for (const path of candidates) if (!run.edited.has(path)) run.scanMentions(path);
  return run.report;
}

export const tools: Tool[] = [
  {
    name: "agents_migrate",
    description:
      "Moves agent memories and settings references that use an agent name listed in the rename table to its current name. Returns JSON { actions, collisions, mentions } and writes nothing unless apply is true. With apply it moves each oh-my-claudeagent-<old> memory directory under the project's .claude/agent-memory and .claude/agent-memory-local and the user config directory's agent-memory to oh-my-claudeagent-<new>, moving each file the target lacks and renaming a colliding file to <stem>.from-<old><ext>. merge_indexes also appends the lines of MEMORY.from-<old>.md that MEMORY.md lacks. It rewrites oh-my-claudeagent:<old> in the user, project and local settings.json and omca-<old> in opencode.json and opencode.jsonc, copying each file to <file>.bak-omca-migrate first. It only lists the CLAUDE.md, AGENTS.md, agent, command, skill and MEMORY.md files that name an old agent.",
    inputSchema: {
      type: "object",
      properties: {
        apply: { type: "boolean", default: false, description: "Make the changes; false only reports them" },
        merge_indexes: { type: "boolean", default: false, description: "Append the lines of MEMORY.from-<old>.md that the target MEMORY.md lacks, then remove the from-file" },
        working_directory: WORKING_DIRECTORY,
      },
    },
    annotations: { title: "Migrate agent names", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    _meta: { "anthropic/searchHint": "move agent memories and settings that use an old agent name to its current name" },
    call: (args) => {
      const input = argReader(args, "agents_migrate");
      const home = homedir();
      const report = migrate({
        apply: input.boolean("apply", false),
        mergeIndexes: input.boolean("merge_indexes", false),
        root: rootOf(input.string("working_directory", "")),
        configDir: configDir(process.env) ?? join(home, ".claude"),
        home,
      });
      return JSON.stringify(report, null, 2);
    },
  },
];
