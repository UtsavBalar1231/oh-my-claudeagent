export type Frontmatter = Record<string, string | string[]>;

const KEY_LINE = /^([A-Za-z_][\w.-]*):(?:[ \t]+(.*))?$/;
const ITEM_LINE = /^[ \t]*-[ \t]+(.*)$/;
const BLOCK_SCALAR = /^[|>][+-]?\d?$/;

const unquote = (value: string): string => /^(["'])(.*)\1$/.exec(value)?.[2] ?? value;

/**
 * Reads the leading `---` block of a Markdown file. Supports `key: value` scalars (kept as strings,
 * one pair of surrounding quotes removed), inline lists `[a, b]` and block lists of `- item` lines.
 * A key with no value and no items is an empty list. Returns undefined when the text has no closed
 * block; throws on syntax outside that subset, such as nested maps or block scalars, rather than
 * returning a wrong value. Quoted items cannot contain commas and `#` is never a comment mid-line.
 */
export function parseFrontmatter(text: string): Frontmatter | undefined {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return undefined;
  const end = lines.indexOf("---", 1);
  if (end === -1) return undefined;

  const result: Frontmatter = {};
  let items: string[] | undefined;
  for (let number = 2; number <= end; number++) {
    const line = lines[number - 1] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const item = ITEM_LINE.exec(line);
    if (item) {
      if (items === undefined) throw new Error(`frontmatter line ${number}: list item outside a list: ${line}`);
      items.push(unquote((item[1] ?? "").trim()));
      continue;
    }
    const pair = KEY_LINE.exec(line);
    if (!pair) throw new Error(`frontmatter line ${number}: unsupported syntax: ${line}`);
    const [, key = "", raw = ""] = pair;
    const value = raw.trim();
    if (BLOCK_SCALAR.test(value)) throw new Error(`frontmatter line ${number}: block scalars are not supported: ${line}`);
    if (value === "") {
      items = [];
      result[key] = items;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      items = undefined;
      result[key] = value
        .slice(1, -1)
        .split(",")
        .map((entry) => unquote(entry.trim()))
        .filter((entry) => entry !== "");
    } else {
      items = undefined;
      result[key] = unquote(value);
    }
  }
  return result;
}
