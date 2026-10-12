import { projectRoot } from "../io.ts";

export type Args = Record<string, unknown>;

export const WORKING_DIRECTORY = { type: "string", default: "", description: "Project root (auto-detected from git)" };

const invalid = (name: string, expected: string, tool?: string): never => {
  throw new Error(`${tool === undefined ? "" : `${tool}: `}${name} must be ${expected}`);
};

const given = (args: Args, name: string, fallback: unknown): unknown => (args[name] === undefined ? fallback : args[name]);

/** A string argument. `fallback` stands in only when the argument is absent, and `tool` prefixes the error. */
export function stringArg(args: Args, name: string, fallback?: string, tool?: string): string {
  const value = given(args, name, fallback);
  return typeof value === "string" ? value : invalid(name, "a string", tool);
}

export function integerArg(args: Args, name: string, fallback: number, tool?: string): number {
  const value = given(args, name, fallback);
  return typeof value === "number" && Number.isInteger(value) ? value : invalid(name, "an integer", tool);
}

export function booleanArg(args: Args, name: string, fallback: boolean, tool?: string): boolean {
  const value = given(args, name, fallback);
  return typeof value === "boolean" ? value : invalid(name, "a boolean", tool);
}

export function stringsArg(args: Args, name: string, tool?: string): string[] | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : invalid(name, "an array of strings", tool);
}

export function choiceArg<T extends string>(args: Args, name: string, allowed: readonly T[], fallback?: T, tool?: string): T {
  const value = given(args, name, fallback);
  return allowed.find((option) => option === value) ?? invalid(name, `one of ${allowed.join(", ")}`, tool);
}

/** The argument readers bound to one tool's arguments, each error prefixed with the tool's name. */
export const argReader = (args: Args, tool: string) => ({
  string: (name: string, fallback?: string) => stringArg(args, name, fallback, tool),
  strings: (name: string) => stringsArg(args, name, tool),
  integer: (name: string, fallback: number) => integerArg(args, name, fallback, tool),
  boolean: (name: string, fallback: boolean) => booleanArg(args, name, fallback, tool),
  choice: <T extends string>(name: string, allowed: readonly T[], fallback?: T) => choiceArg(args, name, allowed, fallback, tool),
});

export const rootOf = (workingDirectory: string): string => projectRoot(workingDirectory || process.cwd());

/** An ISO-8601 UTC timestamp at seconds precision. */
export const isoTimestamp = (at = new Date()): string => at.toISOString().replace(/\.\d{3}Z$/, "Z");
