/** True for a plain object or class instance: not null, not an array. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The value at `key` when `value` is an object, else undefined. */
export const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

/** The value itself when it is a string, else "". */
export const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The string at `key` in a tool's input, or "" when the input is not an object or holds no string there. */
export const inputText = (input: unknown, key: string): string => text(field(input, key));
