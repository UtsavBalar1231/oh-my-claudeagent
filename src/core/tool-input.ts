/** True for a plain object or class instance: not null, not an array. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The string at `key` in a tool's input, or "" when the input is not an object or holds no string there. */
export function inputText(input: unknown, key: string): string {
  const value = isRecord(input) ? input[key] : undefined;
  return typeof value === "string" ? value : "";
}
