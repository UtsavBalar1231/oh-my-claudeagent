import type { Plugin } from "@opencode/plugin";
import type { Info, ToolContext } from "@opencode/plugin/promise/tool";
import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { EVIDENCE_TYPES } from "../src/core/evidence.ts";
import { NOTEPAD_SECTIONS, toPlanName } from "../src/core/notepad.ts";
import { BOULDER, LEDGER } from "../src/core/omca-paths.ts";
import { isRecord } from "../src/core/tool-input.ts";
import { isMissing, readOrNull } from "../servers/io.ts";
import type { Tool } from "../servers/omca.ts";
import type { ToolContext as SharedContext } from "../servers/progress.ts";
import { argReader, isoTimestamp } from "../servers/tools/args.ts";
import { tools as astTools } from "../servers/tools/ast.ts";
import { appendEvidence, COMMAND_MAX_CHARS, SNIPPET_MAX_CHARS, tools as evidenceTools, VERIFIED_BY_MAX_CHARS } from "../servers/tools/evidence.ts";
import { tools as filesystemTools } from "../servers/tools/filesystem.ts";
import { appendNotepad, compactNotepad, formatNotepadList, type NotepadListing, tools as notepadTools } from "../servers/tools/notepad.ts";
import { canonicalPath, checkPath, ownedPath, requestScope, type RequestScope, within } from "./permissions.ts";
import { boundPlan, readBoundPlan, readSnapshot } from "./state.ts";

const DIRECT = new Set(["evidence_log", "boulder_progress", "notepad_write"]);
const MAX_AST_FILES = 100;
const SHA256 = /^[0-9a-f]{64}$/;
const cap = (text: string, max: number) => Array.from(text).slice(0, max).join("");
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function schema(tool: Tool): Tool["inputSchema"] {
  const properties = { ...tool.inputSchema.properties };
  delete properties.working_directory;
  delete properties.session_id;
  if (tool.name === "evidence_log") {
    properties.evidence_type = { type: "string", enum: EVIDENCE_TYPES, description: "Attested run category; final_verification requires the exact bound-plan hash." };
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
  if (tool.name === "evidence_log") return "Record an attested command result with its real integer exit code. This is historical evidence, not a native execution receipt or verified completion. final_verification requires this session's bound-plan hash from omca_boulder_progress.";
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
  await scope.paths("read", [join(scope.root, BOULDER), join(scope.root, LEDGER)], true);
  const registry = readOrNull(join(scope.root, BOULDER));
  const bound = await boundPlan(scope.directory, context.sessionID);
  if (bound !== null) {
    await scope.paths("read", [bound.path]);
    await scope.paths("read", NOTEPAD_SECTIONS.map((section) => join(scope.root, ".omca", "notepads", toPlanName(bound.name), `${section}.md`)), true);
  }
  await scope.current();
  if (readOrNull(join(scope.root, BOULDER)) !== registry) throw new Error("Plan binding changed during permission approval; retry against the current binding");
  return readSnapshot(scope.directory, context.sessionID, bound);
}

async function authorizedPlan(scope: RequestScope, context: ToolContext) {
  await scope.paths("read", [join(scope.root, BOULDER)], true);
  const bound = boundPlan(scope.directory, context.sessionID);
  if (bound !== null) await scope.paths("read", [bound.path]);
  await scope.current();
  return readBoundPlan(scope.directory, context.sessionID, bound);
}

async function evidenceLog(args: Record<string, unknown>, scope: RequestScope, context: ToolContext): Promise<string> {
  const a = argReader(args, "omca_evidence_log");
  const type = a.choice("evidence_type", EVIDENCE_TYPES);
  const command = cap(a.string("command"), COMMAND_MAX_CHARS);
  const exitCode = a.integer("exit_code", Number.NaN);
  const output = cap(a.string("output_snippet"), SNIPPET_MAX_CHARS);
  const verifiedBy = cap(a.string("verified_by", ""), VERIFIED_BY_MAX_CHARS);
  const planSha = a.string("plan_sha256", "");
  if (planSha !== "" && !SHA256.test(planSha)) throw new Error("plan_sha256 must be 64 lowercase hex digits");
  let planPath: string | undefined;
  if (type === "final_verification") {
    const plan = await authorizedPlan(scope, context);
    if (plan === null || planSha === "" || planSha !== plan.sha256) throw new Error("final_verification requires the exact current hash of this native session's bound plan");
    planPath = plan.path;
  }
  const path = join(scope.root, LEDGER);
  await scope.paths("read", [path, `${path}.lock`], true);
  await scope.paths("edit", [path, `${path}.lock`, dirname(path)], true);
  const initializeState = await scope.authorizeStateWrite();
  await scope.current();
  const recordID = createHash("sha256").update(JSON.stringify([context.sessionID, context.messageID, context.id])).digest("hex");
  const total = await appendEvidence(scope.root, {
    type, command, exit_code: exitCode, output_snippet: output, timestamp: isoTimestamp(),
    ...(verifiedBy && { verified_by: verifiedBy }), ...(planSha && { plan_sha256: planSha }),
    origin: "attested", record_id: recordID,
    provenance: { adapter: "opencode", session_id: context.sessionID, message_id: context.messageID, call_id: context.id },
  }, async () => {
    await initializeState();
    await scope.current();
    ownedPath(scope.root, path);
    if (planPath !== undefined) {
      const currentBound = await boundPlan(scope.directory, context.sessionID);
      await scope.current();
      if (currentBound?.path !== planPath || hash(planPath) !== planSha) throw new Error("Bound plan changed before evidence could be recorded; refresh omca_boulder_progress");
    }
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
  for (const name of ["boulder_progress", "health_check"]) {
    definitions.push({
      name,
      description: name === "boulder_progress" ? "Read only this native session's explicitly bound plan. Return numbered-task progress and the current plan_sha256. No binding is inferred from other sessions." : "Read checkout-local native OMCA health. Historical ledger evidence is not native verified completion; OpenCode has no documented Stop veto.",
      input: { type: "object", properties: {}, additionalProperties: false },
      options: { namespace: "omca", codemode: name !== "boulder_progress" },
      execute: async (input, context) => {
        const scope = await requestScope(ctx, context, isRecord(input) ? input : {}, `omca_${name}`);
        if (name === "health_check") {
          const state = await snapshot(scope, context);
          return { content: JSON.stringify({ adapter: "native", health: state.health, verification: state.evidence.verdict }, null, 2) };
        }
        const plan = await authorizedPlan(scope, context);
        if (plan === null) return { content: JSON.stringify({ session_id: context.sessionID, plan: null }, null, 2) };
        const { tasks } = plan;
        const completed = tasks.filter((task) => task.checked).length;
        return { content: JSON.stringify({ plan_name: plan.name, plan_path: plan.path, plan_sha256: plan.sha256, total: tasks.length, completed, remaining: tasks.length - completed, next_task_label: tasks.find((task) => !task.checked)?.label ?? null }, null, 2) };
      },
    });
  }
  await ctx.tool.transform((editor) => {
    editor.namespace({ name: "omca", description: "Session-aware OMCA evidence, notepads, plan progress, structural code tools, and file reads with native permissions." });
    for (const definition of definitions) editor.add(definition);
  });
}
