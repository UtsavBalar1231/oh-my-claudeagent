import type { Plugin } from "@opencode/plugin";
import type { Info, ToolContext } from "@opencode/plugin/promise/tool";
import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { EVIDENCE_TYPES } from "../src/core/evidence.ts";
import { formatTask, formatTasks } from "../src/core/native-tasks.ts";
import { NOTEPAD_SECTIONS, toPlanName } from "../src/core/notepad.ts";
import { LEDGER } from "../src/core/omca-paths.ts";
import { isRecord } from "../src/core/tool-input.ts";
import { isMissing } from "../servers/io.ts";
import type { Tool } from "../servers/omca.ts";
import type { ToolContext as SharedContext } from "../servers/progress.ts";
import { argReader, isoTimestamp } from "../servers/tools/args.ts";
import { tools as astTools } from "../servers/tools/ast.ts";
import { workingTreeStamp } from "../servers/tree-stamp.ts";
import { appendEvidence, COMMAND_MAX_CHARS, SNIPPET_MAX_CHARS, TASK_ID_MAX_CHARS, tools as evidenceTools, VERIFIED_BY_MAX_CHARS } from "../servers/tools/evidence.ts";
import { tools as filesystemTools } from "../servers/tools/filesystem.ts";
import { appendNotepad, compactNotepad, formatNotepadList, type NotepadListing, tools as notepadTools } from "../servers/tools/notepad.ts";
import { canonicalPath, checkPath, ownedPath, requestScope, type RequestScope, within } from "./permissions.ts";
import { currentRun, readSnapshot, readTaskFiles, TASKS_DIR } from "./state.ts";
import { createTask, TASK_STATUSES, tasksLock, updateTask } from "./tasks.ts";

const DIRECT = new Set(["evidence_log", "notepad_write"]);
const MAX_AST_FILES = 100;
const COORDINATOR_AGENT = "omca";
const TASK_FIELDS = {
  subject: { type: "string", description: "A short imperative title." },
  description: { type: "string", description: "What done means for this task and how to check it." },
  activeForm: { type: "string", description: "Present-continuous wording shown while the task runs." },
};
const cap = (text: string, max: number) => Array.from(text).slice(0, max).join("");
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function schema(tool: Tool): Tool["inputSchema"] {
  const properties = { ...tool.inputSchema.properties };
  delete properties.working_directory;
  delete properties.session_id;
  if (tool.name === "evidence_log") {
    properties.evidence_type = { type: "string", enum: EVIDENCE_TYPES, description: "Attested run category; final_verification requires task_id." };
    properties.exit_code = { type: "integer", description: "The real command exit code. Zero records an attested success, not native verification." };
  }
  const required = Array.isArray(tool.inputSchema.required) ? [...tool.inputSchema.required] : [];
  if (["ast_search", "ast_find_rule", "ast_replace"].includes(tool.name)) {
    properties.paths = { type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_AST_FILES, description: "Explicit regular-file paths in the current checkout. Enumerate files with native glob first; directories and symlinks are refused." };
    required.push("paths");
  }
  if (tool.name === "file_read") properties.path = { type: "string", description: "A current-checkout-relative or absolute path, subject to native file permissions." };
  return { ...tool.inputSchema, required, properties, additionalProperties: false };
}

function description(tool: Tool): string {
  if (tool.name === "evidence_log") return "Record an attested command result with its real integer exit code. This is historical evidence, not a native execution receipt or verified completion. final_verification is a run's verdict and names the run's final task with task_id; that task cannot complete until a passing verdict names it.";
  if (tool.name === "file_read") return "Read a regular text file with line numbers and paging, subject to native read and external_directory permissions and the sensitive/network-path denylist. Non-plan calls also require edit permission for a checkout-local audit entry. Plan-agent reads create no files.";
  if (["ast_search", "ast_find_rule", "ast_replace"].includes(tool.name)) {
    const operation = tool.name === "ast_search" ? "Find code by syntax pattern, not text or regular expression. Use $VAR for one AST node and $$$ for several."
      : tool.name === "ast_find_rule" ? "Find code with an ast-grep YAML rule. Use relational rules when a simple pattern cannot express the structure."
      : "Preview a syntax rewrite with dry_run=true before applying it. Apply requires identical arguments and unchanged files from that session's preview, plus native edit approval.";
    return `${operation} Enumerate files with glob first, then supply at most ${MAX_AST_FILES} explicit regular-file paths inside this checkout. Directories, symlinks and sensitive paths are refused. Repository ast-grep configuration and ignore files are disabled. Results are bounded by max_results.`;
  }
  return tool.description;
}

async function snapshot(scope: RequestScope, context: ToolContext) {
  await scope.paths("read", [join(scope.root, TASKS_DIR), join(scope.root, LEDGER)], true);
  const run = currentRun(readTaskFiles(scope.root).tasks);
  if (run !== null) await scope.paths("read", NOTEPAD_SECTIONS.map((section) => join(scope.root, ".omca", "notepads", toPlanName(run.name), `${section}.md`)), true);
  await scope.current();
  return readSnapshot(scope.directory, context.sessionID, run?.name ?? null);
}

async function evidenceLog(args: Record<string, unknown>, scope: RequestScope, context: ToolContext): Promise<string> {
  const a = argReader(args, "omca_evidence_log");
  const type = a.choice("evidence_type", EVIDENCE_TYPES);
  const command = cap(a.string("command"), COMMAND_MAX_CHARS);
  const exitCode = a.integer("exit_code", Number.NaN);
  const output = cap(a.string("output_snippet"), SNIPPET_MAX_CHARS);
  const verifiedBy = cap(a.string("verified_by", ""), VERIFIED_BY_MAX_CHARS);
  const taskId = cap(a.string("task_id", ""), TASK_ID_MAX_CHARS);
  const finalTask = async () => {
    if (!readTaskFiles(scope.root).tasks.some((task) => task.id === taskId && task.isFinal)) throw new Error("final_verification requires the task_id of a run's final task");
  };
  if (type === "final_verification") {
    await scope.paths("read", [join(scope.root, TASKS_DIR)], true);
    await finalTask();
  }
  const path = join(scope.root, LEDGER);
  await scope.paths("read", [path, `${path}.lock`], true);
  await scope.paths("edit", [path, `${path}.lock`, dirname(path)], true);
  const initializeState = await scope.authorizeStateWrite();
  await scope.current();
  const recordID = createHash("sha256").update(JSON.stringify([context.sessionID, context.messageID, context.id])).digest("hex");
  const tree = await workingTreeStamp(scope.root);
  const total = await appendEvidence(scope.root, {
    type, command, exit_code: exitCode, output_snippet: output, timestamp: isoTimestamp(),
    ...(verifiedBy && { verified_by: verifiedBy }), ...(taskId && { task_id: taskId }), ...(tree !== null && { tree }),
    origin: "attested", record_id: recordID,
    provenance: { adapter: "opencode", session_id: context.sessionID, message_id: context.messageID, call_id: context.id },
  }, async () => {
    await initializeState();
    await scope.current();
    ownedPath(scope.root, path);
    if (type === "final_verification") await finalTask();
  });
  return `Attested evidence recorded: ${type} (exit ${exitCode}), ${total} total entries`;
}

async function notepadPermissions(name: string, args: Record<string, unknown>, scope: RequestScope, write: boolean) {
  const a = argReader(args, name);
  const plan = a.string("plan_name", "");
  const base = join(scope.root, ".omca", "notepads");
  const listing: NotepadListing = [];
  await scope.paths("read", [base], true);
  const plans = plan === "" && name === "notepad_list"
    ? (() => {
        try {
          return readdirSync(base, { withFileTypes: true }).map((entry) => {
            if (entry.isSymbolicLink()) throw new Error(`Notepad symlinks are not allowed: ${entry.name}`);
            return entry.isDirectory() ? toPlanName(entry.name) : null;
          }).filter((entry): entry is string => entry !== null).sort();
        } catch (error) {
          if (isMissing(error)) return [];
          throw error;
        }
      })()
    : [toPlanName(plan)];
  for (const planName of plans) {
    const dir = join(base, planName);
    await scope.paths("read", [dir], true);
    const sections = args.section == null ? NOTEPAD_SECTIONS : [a.choice("section", NOTEPAD_SECTIONS)];
    const files = sections.map((section) => join(dir, `${section}.md`));
    if (name === "notepad_list") {
      try {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          ownedPath(scope.root, join(dir, entry));
          files.push(join(dir, entry));
        }
        listing.push({ name: planName, files: entries });
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    const locks = write ? files.map((file) => `${file}.lock`) : [];
    await scope.paths("read", [...files, ...locks], true);
    if (write) {
      const outputs = [...files, ...locks, dir, base];
      if (name === "notepad_write") await scope.authorizeStateWrite();
      await scope.paths("edit", outputs, true);
    }
  }
  return listing;
}

async function astPaths(args: Record<string, unknown>, scope: RequestScope, write: boolean) {
  const requested = argReader(args, "native AST").strings("paths");
  if (!requested?.length || requested.length > MAX_AST_FILES) throw new Error(`Native AST tools require 1-${MAX_AST_FILES} explicit regular-file paths; enumerate files with the native glob tool first`);
  const files = requested.map((path) => {
    checkPath(path);
    const absolute = resolve(scope.root, path);
    if (!within(scope.root, absolute)) throw new Error("Native AST paths must remain inside the current checkout");
    let current = scope.root;
    for (const part of relative(scope.root, absolute).split(sep)) {
      if ([".git", "node_modules"].includes(part)) throw new Error("Native AST tools do not scan .git or node_modules");
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Native AST paths must not contain symlinks: ${path}`);
    }
    if (!lstatSync(absolute).isFile()) throw new Error(`Native AST tools require explicit regular files, not directories: ${path}`);
    return absolute;
  });
  const checked = [...new Set(await scope.paths("read", files))];
  if (write) await scope.paths("edit", checked);
  return checked;
}

export async function registerTools(ctx: Plugin.Context, changed: (sessionID: string) => Promise<void>): Promise<void> {
  const previews = new Map<string, string>();
  const descriptors: Tool[] = [...evidenceTools, ...notepadTools, ...astTools, ...filesystemTools];
  const definitions: Info[] = descriptors.map((tool): Info => ({
    name: tool.name,
    description: description(tool),
    input: schema(tool),
    options: { namespace: "omca", codemode: !DIRECT.has(tool.name) },
    execute: async (input, context) => {
      if (!isRecord(input)) throw new Error("Tool input must be an object");
      const scope = await requestScope(ctx, context, input, `omca_${tool.name}`);
      const args: Record<string, unknown> = { ...input, working_directory: scope.root };
      const write = tool.name === "evidence_log" || tool.name === "notepad_write" || tool.name === "notepad_compact" || (tool.name === "ast_replace" && input.dry_run === false);
      if (write && context.agent === "plan") throw new Error("OMCA writes are unavailable to the plan agent");
      let pending = Promise.resolve();
      let progressError: unknown;
      const shared: SharedContext = {
        signal: context.signal, workspaceRoot: scope.root, audit: false,
        progress: (update) => { pending = pending.then(() => context.progress({ status: update.message, ...update })).catch((error: unknown) => { progressError = error; }); },
      };
      let content: string;
      try {
        if (tool.name === "evidence_log") content = await evidenceLog(args, scope, context);
        else if (tool.name === "evidence_read") {
          await scope.paths("read", [join(scope.root, LEDGER)], true);
          content = await tool.call(args, shared);
        } else if (tool.name.startsWith("notepad_")) {
          const listing = await notepadPermissions(tool.name, args, scope, write);
          await scope.current();
          if (tool.name === "notepad_write") content = await appendNotepad(scope.root, args.plan_name, args.section, args.content, scope.current);
          else if (tool.name === "notepad_compact") content = await compactNotepad(scope.root, args.plan_name, args.section, scope.current);
          else if (tool.name === "notepad_list") content = formatNotepadList(listing, argReader(args, tool.name).string("plan_name", ""));
          else content = await tool.call(args, shared);
        } else if (tool.name === "file_read") {
          const path = argReader(args, tool.name).string("path");
          const [file] = await scope.paths("read", [path]);
          const audit = join(scope.root, ".omca", "logs", "file-access.jsonl");
          if (context.agent !== "plan") {
            await scope.paths("edit", [audit, dirname(audit)], true);
            const initializeState = await scope.authorizeStateWrite();
            await initializeState();
          }
          await scope.current();
          content = await tool.call({ ...args, path: file }, shared);
          if (context.agent !== "plan") {
            await scope.current();
            ownedPath(scope.root, audit);
            mkdirSync(dirname(audit), { recursive: true });
            appendFileSync(audit, `${JSON.stringify({ path: file, allowed: !/^(Access denied|Binary file|Not a regular|Path is a directory|File too large|File not found)/.test(content), timestamp: isoTimestamp() })}\n`);
          }
        } else if (["ast_search", "ast_find_rule", "ast_replace"].includes(tool.name)) {
          const files = await astPaths(args, scope, write);
          const key = JSON.stringify([context.sessionID, scope.root, args.pattern, args.rewrite, args.lang, files, args.globs]);
          const fingerprints = () => JSON.stringify(files.map((file) => {
            if (canonicalPath(file) !== file || !lstatSync(file).isFile()) throw new Error(`AST input changed after permission approval: ${file}`);
            return [file, hash(file)];
          }));
          const before = fingerprints();
          if (write && previews.get(key) !== before) throw new Error("Run omca_ast_replace with dry_run=true in this session using identical arguments and unchanged files before applying");
          await scope.current();
          if (fingerprints() !== before) throw new Error("AST input changed before execution; preview the current files again");
          content = await tool.call({ ...args, paths: files }, {
            ...shared,
            ...(write && { beforeApply: async () => {
              await scope.current();
              if (fingerprints() !== before) throw new Error("AST input changed during preview; preview the current files again");
            } }),
          });
          if (tool.name === "ast_replace") {
            previews.delete(key);
            if (!write && !content.includes("[TRUNCATED]") && fingerprints() === before) {
              if (previews.size >= 100) previews.delete(previews.keys().next().value!);
              previews.set(key, before);
            }
          }
        } else {
          await scope.assert(`omca_${tool.name}`, ["*"]);
          content = await tool.call(args, shared);
        }
      } finally {
        await pending;
      }
      if (progressError !== undefined) throw progressError;
      context.signal.throwIfAborted();
      if (write) await changed(context.sessionID);
      return { content };
    },
  }));
  definitions.push({
    name: "health_check",
    description: "Read checkout-local native OMCA health. Historical ledger evidence is not native verified completion; OpenCode has no documented Stop veto.",
    input: { type: "object", properties: {}, additionalProperties: false },
    options: { namespace: "omca", codemode: true },
    execute: async (input, context) => {
      const scope = await requestScope(ctx, context, isRecord(input) ? input : {}, "omca_health_check");
      const state = await snapshot(scope, context);
      return { content: JSON.stringify({ adapter: "native", health: state.health, verification: state.evidence.verdict }, null, 2) };
    },
  });

  const writableScope = async (input: unknown, context: ToolContext, name: string) => {
    if (context.agent !== COORDINATOR_AGENT) throw new Error("Only the OMCA coordinator changes the task list");
    const scope = await requestScope(ctx, context, isRecord(input) ? input : {}, `omca_${name}`);
    const lock = tasksLock(scope.root);
    await scope.paths("read", [join(scope.root, TASKS_DIR), join(scope.root, LEDGER), lock], true);
    await scope.paths("edit", [join(scope.root, TASKS_DIR), lock], true);
    const initializeState = await scope.authorizeStateWrite();
    await scope.current();
    return {
      scope,
      beforeWrite: async () => {
        await initializeState();
        await scope.current();
        ownedPath(scope.root, join(scope.root, TASKS_DIR));
      },
    };
  };
  const readableScope = async (input: unknown, context: ToolContext, name: string) => {
    const scope = await requestScope(ctx, context, isRecord(input) ? input : {}, `omca_${name}`);
    await scope.paths("read", [join(scope.root, TASKS_DIR)], true);
    await scope.current();
    return scope;
  };
  definitions.push(
    {
      name: "task_create",
      description: "Add a task to this checkout's task list, which every session in the checkout shares. metadata.run names the run; metadata.final marks the run's last task, which cannot complete until a passing final_verification names it. New tasks start pending; link them with omca_task_update.",
      input: {
        type: "object",
        properties: { ...TASK_FIELDS, metadata: { type: "object", properties: { run: { type: "string" }, final: { type: "boolean" } }, required: ["run"], additionalProperties: true } },
        required: ["subject", "description", "metadata"],
        additionalProperties: false,
      },
      options: { namespace: "omca", codemode: false },
      execute: async (input, context) => {
        const a = argReader(isRecord(input) ? input : {}, "omca_task_create");
        const metadata = isRecord(input) && isRecord(input.metadata) ? input.metadata : {};
        if (typeof metadata.run !== "string" || metadata.run.trim() === "") throw new Error("omca_task_create: metadata.run must name the run");
        const fields = { subject: a.string("subject"), description: a.string("description"), activeForm: a.string("activeForm", ""), metadata };
        const { scope, beforeWrite } = await writableScope(input, context, "task_create");
        const task = await createTask(scope.root, fields, beforeWrite);
        await changed(context.sessionID);
        return { content: `Task #${task.id} created: ${task.subject}` };
      },
    },
    {
      name: "task_update",
      description: "Change a task: set status, link it with addBlocks or addBlockedBy, or merge metadata, where null removes a key. Set metadata.blocked to the reason to close a task without completing it. A run's final task refuses completed until a passing final_verification names it, and refuses deleted or metadata.blocked until a final_verification of any outcome names it.",
      input: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          status: { type: "string", enum: TASK_STATUSES },
          ...TASK_FIELDS,
          owner: { type: "string" },
          addBlocks: { type: "array", items: { type: "string" } },
          addBlockedBy: { type: "array", items: { type: "string" } },
          metadata: { type: "object", additionalProperties: true },
        },
        required: ["taskId"],
        additionalProperties: false,
      },
      options: { namespace: "omca", codemode: false },
      execute: async (input, context) => {
        const args = isRecord(input) ? input : {};
        const a = argReader(args, "omca_task_update");
        const taskId = a.string("taskId");
        const addBlocks = a.strings("addBlocks");
        const addBlockedBy = a.strings("addBlockedBy");
        const change = {
          taskId,
          ...(args.status !== undefined && { status: a.choice("status", TASK_STATUSES) }),
          ...(args.subject !== undefined && { subject: a.string("subject") }),
          ...(args.description !== undefined && { description: a.string("description") }),
          ...(args.activeForm !== undefined && { activeForm: a.string("activeForm") }),
          ...(args.owner !== undefined && { owner: a.string("owner") }),
          ...(addBlocks !== undefined && { addBlocks }),
          ...(addBlockedBy !== undefined && { addBlockedBy }),
          ...(isRecord(args.metadata) && { metadata: args.metadata }),
        };
        const { scope, beforeWrite } = await writableScope(input, context, "task_update");
        const task = await updateTask(scope.root, change, beforeWrite);
        await changed(context.sessionID);
        return { content: task === null ? `Task #${taskId} deleted` : `Task #${task.id} [${task.status}] ${task.subject}` };
      },
    },
    {
      name: "task_list",
      description: "Read this checkout's task list: id, status, subject, whether it is a run's final task, the open tasks it waits on, and why it was closed as blocked. A task completed or closed as blocked holds nothing back.",
      input: { type: "object", properties: {}, additionalProperties: false },
      options: { namespace: "omca", codemode: false },
      execute: async (input, context) => {
        const scope = await readableScope(input, context, "task_list");
        return { content: formatTasks(readTaskFiles(scope.root).tasks) };
      },
    },
    {
      name: "task_get",
      description: "Read one task in full, with its description and metadata. blockedBy names every link and openBlockers the ones still holding it: a task completed or closed as blocked holds nothing back. A task closed as blocked keeps status pending, with its reason in blockedReason.",
      input: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"], additionalProperties: false },
      options: { namespace: "omca", codemode: false },
      execute: async (input, context) => {
        const taskId = argReader(isRecord(input) ? input : {}, "omca_task_get").string("taskId");
        const scope = await readableScope(input, context, "task_get");
        const { tasks } = readTaskFiles(scope.root);
        const task = tasks.find(({ id }) => id === taskId);
        if (task === undefined) throw new Error(`Task #${taskId} is not on the list`);
        return { content: formatTask(task, tasks) };
      },
    },
  );
  await ctx.tool.transform((editor) => {
    editor.namespace({ name: "omca", description: "Session-aware OMCA evidence, notepads, the checkout's task list, structural code tools, and file reads with native permissions." });
    for (const definition of definitions) editor.add(definition);
  });
}
