/** The string at `key` in a tool's input, or "" when the input is not an object or holds no string there. */
export function inputText(input: unknown, key: string): string {
  if (typeof input !== "object" || input === null) return "";
  const value = Reflect.get(input, key);
  return typeof value === "string" ? value : "";
}
