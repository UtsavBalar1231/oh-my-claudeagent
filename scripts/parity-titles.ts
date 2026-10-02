import { existsSync, readFileSync } from "node:fs";

const USAGE = "usage: bun scripts/parity-titles.ts <bats-file-or-rev:path> <ts-test-file> [--replaced <title>...]";

const titlePattern = (prefix: string) =>
  new RegExp(`${prefix}(["'])((?:\\\\.|(?!\\1)[^\\\\\\n])*)\\1`, "gm");

const BATS_TITLE = titlePattern("^[ \\t]*@test[ \\t]+");
const TS_TITLE = titlePattern("(?<![\\w.])(?:test|it)\\([ \\t\\n]*");

const titlesIn = (source: string, pattern: RegExp) =>
  [...source.matchAll(pattern)].map((match) => (match[2] ?? "").replace(/\\(.)/g, "$1").trim());

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const readBats = (spec: string) => {
  if (existsSync(spec)) return readFileSync(spec, "utf8");
  const shown = Bun.spawnSync(["git", "show", spec]);
  return shown.success ? shown.stdout.toString() : fail(`cannot read ${spec}: ${shown.stderr.toString().trim()}`);
};

const [batsSpec, tsPath, ...rest] = process.argv.slice(2);
const flag = rest[0];
if (!batsSpec || !tsPath || (flag !== undefined && flag !== "--replaced")) {
  fail(USAGE);
}

const replaced = new Set(rest.slice(1).map((title) => title.trim()));
const tsSource = existsSync(tsPath) ? readFileSync(tsPath, "utf8") : fail(`cannot read ${tsPath}`);
const ported = new Set(titlesIn(tsSource, TS_TITLE));
const missing = titlesIn(readBats(batsSpec), BATS_TITLE).filter(
  (title) => !ported.has(title) && !replaced.has(title),
);

if (missing.length > 0) {
  console.error(`${missing.length} bats title(s) missing from ${tsPath}:`);
  console.log(missing.join("\n"));
  process.exit(1);
}
