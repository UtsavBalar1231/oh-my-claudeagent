import type { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { toPlatform } from "../src/core/path.ts";
import { ensureStateDir, isMissing, projectRoot } from "../servers/io.ts";
import { isNetworkPath, isSensitivePath } from "../servers/tools/filesystem.ts";

const platform = toPlatform(process.platform);

export function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel.split(sep)[0] !== "..");
}

export function checkPath(path: string): void {
  if (path.includes("\0") || isNetworkPath(platform, path)) throw new Error("Network paths and null bytes are not allowed");
  if (isSensitivePath(platform, path)) throw new Error(`Access denied: ${path} matches sensitive file pattern`);
}

export function canonicalPath(path: string): string {
  checkPath(path);
  try {
    const canonical = realpathSync.native(path);
    checkPath(canonical);
    return canonical;
  } catch (error) {
    if (!isMissing(error)) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(canonicalPath(parent), relative(parent, path));
  }
}

function lockPaths(path: string): string[] {
  if (!path.endsWith(".lock")) return [path];
  return [path, `${path}.break`, `${path}.d`, join(`${path}.d`, "owner"), `${path}.break.d`, join(`${path}.break.d`, "owner")];
}

export function ownedPath(root: string, path: string): void {
  const base = join(root, ".omca");
  for (const target of lockPaths(path)) {
    if (!within(base, target)) throw new Error(`Not an OMCA-owned path: ${target}`);
    let current = root;
    for (const part of relative(root, target).split(sep)) {
      current = join(current, part);
      const stat = lstatSync(current, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink()) throw new Error(`OMCA paths must not contain symlinks: ${current}`);
    }
    if (!within(base, canonicalPath(target))) throw new Error(`OMCA path escapes checkout: ${target}`);
  }
}

type OperationContext = {
  sessionID: string;
  agent?: string;
  signal: AbortSignal;
  source?: { type: "tool"; messageID: string; id: string };
};

export async function operationScope(ctx: Plugin.Context, context: OperationContext, input: Record<string, unknown> = {}, nativeAction?: string) {
  context.signal.throwIfAborted();
  const sessionAt = async () => ctx.session.get({ sessionID: context.sessionID });
  const directory = (await sessionAt()).location.directory;
  const active = realpathSync.native(directory);
  const root = realpathSync.native(projectRoot(directory));
  for (const field of ["working_directory", "workspaceRoot", "root", "directory"]) {
    const value = input[field];
    if (value !== undefined && value !== "" && (typeof value !== "string" || canonicalPath(resolve(directory, value)) !== root)) {
      throw new Error(`${field} cannot override this session's checkout`);
    }
  }
  for (const field of ["session_id", "sessionID"]) {
    if (input[field] !== undefined && input[field] !== "" && input[field] !== context.sessionID) {
      throw new Error(`${field} cannot override the executing session`);
    }
  }
  const approved = new Map<string, { canonical: string; owned: boolean }>();
  let mutating = false;
  const current = async () => {
    context.signal.throwIfAborted();
    const session = await sessionAt();
    if (session.location.directory !== directory) throw new Error("Session location changed during tool execution; retry in the current checkout");
    if (mutating && session.agent === "plan") throw new Error("Session switched to the plan agent; OMCA writes are unavailable");
    if (realpathSync.native(projectRoot(directory)) !== root) throw new Error("Session checkout changed during tool execution");
    for (const [absolute, { canonical, owned }] of approved) {
      if (canonicalPath(absolute) !== canonical) throw new Error(`Path changed after permission approval: ${absolute}`);
      if (owned) ownedPath(root, absolute);
    }
  };
  const assert = async (action: string, resources: string[]) => {
    await ctx.permission.assert({
      sessionID: context.sessionID,
      ...(context.agent ? { agent: context.agent } : {}),
      ...(context.source ? { source: context.source } : {}),
      action,
      resources,
      save: resources,
    });
    await current();
  };
  const internal = (path: string) => within(active, path) || within(root, path);
  const resource = (path: string) => (internal(path) ? relative(active, path) || "." : path).split(sep).join("/");
  const paths = async (action: "read" | "edit", requested: string[], owned = false) => {
    if (action === "edit" && context.agent === "plan") throw new Error("OMCA writes are unavailable to the plan agent");
    if (action === "edit") mutating = true;
    const checked = (owned ? requested.flatMap(lockPaths) : requested).map((path) => {
      checkPath(path);
      const absolute = resolve(root, path);
      if (owned) ownedPath(root, absolute);
      return { absolute, canonical: canonicalPath(absolute) };
    });
    const external = [...new Set(checked.flatMap(({ absolute, canonical }) => [absolute, canonical]).filter((path) => !internal(path)).map((path) => join(canonicalPath(dirname(path)), "*").split(sep).join("/")))];
    if (external.length > 0) await assert("external_directory", external);
    const resources = [...new Set(checked.flatMap(({ absolute, canonical }) => [resource(absolute), resource(canonical)]))];
    if (nativeAction !== undefined) await assert(nativeAction, resources);
    await assert(action, resources);
    for (const { absolute, canonical } of checked) {
      if (canonicalPath(absolute) !== canonical) throw new Error(`Path changed during permission approval: ${absolute}`);
      if (owned) ownedPath(root, absolute);
      approved.set(absolute, { canonical, owned });
    }
    return checked.map(({ canonical }) => canonical);
  };
  const authorizeStateWrite = async () => {
    const base = join(root, ".omca");
    await paths("read", [join(base, ".gitignore")], true);
    await paths("edit", [base, join(base, "state"), join(base, ".gitignore")], true);
    return async () => {
      await current();
      ensureStateDir(root);
    };
  };
  return { root, directory, assert, paths, current, authorizeStateWrite };
}

export function requestScope(ctx: Plugin.Context, context: ToolContext, input: Record<string, unknown>, nativeAction?: string) {
  return operationScope(ctx, {
    sessionID: context.sessionID, agent: context.agent, signal: context.signal,
    source: { type: "tool", messageID: context.messageID, id: context.id },
  }, input, nativeAction);
}

export type RequestScope = Awaited<ReturnType<typeof requestScope>>;
