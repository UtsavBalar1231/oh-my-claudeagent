import { projectRoot } from "../io.ts";

export type Args = Record<string, unknown>;

export const WORKING_DIRECTORY = { type: "string", default: "", description: "Project root (auto-detected from git)" };

/** A string argument. `fallback` stands in only when the argument is absent, and `tool` prefixes the error. */
export function stringArg(args: Args, name: string, fallback?: string, tool?: string): string {
  const value = args[name] === undefined ? fallback : args[name];
  if (typeof value !== "string") throw new Error(`${tool === undefined ? "" : `${tool}: `}${name} must be a string`);
  return value;
}

export function integerArg(args: Args, name: string, fallback: number): number {
  const value = args[name] === undefined ? fallback : args[name];
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

/** `stringArg` bound to one tool's arguments, so each call site names only the argument. */
export const stringReader =
  (args: Args, tool: string) =>
  (name: string, fallback?: string): string =>
    stringArg(args, name, fallback, tool);

export const rootOf = (workingDirectory: string): string => projectRoot(workingDirectory || process.cwd());

/** An ISO-8601 UTC timestamp at seconds precision. */
export const isoTimestamp = (at = new Date()): string => at.toISOString().replace(/\.\d{3}Z$/, "Z");
