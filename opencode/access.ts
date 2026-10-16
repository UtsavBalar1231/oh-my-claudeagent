import type { Plugin } from "@opencode/plugin"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { checkPath, operationScope } from "./permissions.ts"

export { canonicalPath } from "./permissions.ts"

export function resolvePath(directory: string, path: string): string {
  checkPath(path)
  const expanded = path === "~" ? homedir() : path.startsWith("~/") || path.startsWith("~\\") ? join(homedir(), path.slice(2)) : path
  return resolve(directory, expanded)
}

export async function authorizePath(
  ctx: Plugin.Context,
  sessionID: string,
  agent: string | undefined,
  directory: string,
  path: string,
  action: "read" | "edit",
): Promise<string> {
  const absolute = resolvePath(directory, path)
  const scope = await operationScope(ctx, { sessionID, ...(agent ? { agent } : {}), signal: new AbortController().signal })
  if (scope.directory !== directory) throw new Error("Session location changed during permission approval")
  const [canonical] = await scope.paths(action, [absolute])
  if (!canonical) throw new Error("No authorized path")
  return canonical
}
