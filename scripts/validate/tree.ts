import { closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { type Check, type Context, type Outcome, readText, verdict } from "./core.ts";

// A script that still needs a shebang, and why. A new interpreter script fails the check until
// it is added here with its reason, and an entry whose file lost its shebang fails as stale.
export const SHEBANG_ALLOWLIST: Readonly<Record<string, string>> = {
  "opencode/test/smoke.sh": "run by `just test-opencode` and the OpenCode CI job against a real OpenCode install",
  "opencode/test/model-path.sh": "run by `just test-opencode` and the OpenCode CI job against a real OpenCode install",
  "tests/evals/run-eval.sh": "run by `just eval-consistency` to list the eval tasks",
  "scripts/probe-userpromptsubmit-payload.sh": "one-shot payload probe a maintainer registers by hand, never in hooks.json",
};

const SHEBANG = /^#![ \t]*(?:\S*\/env[ \t]+(?:-S[ \t]+)?)?(?:\S*\/)?(?:python[\d.]*|bash|sh)(?:[ \t]|$)/;
const NODE_OR_BUN_IMPORT = /\b(?:from|import|require)\s*\(?\s*["'](?:node|bun):/;

function firstLine(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(256);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString("utf8").split(/\r?\n/)[0] ?? "";
  } finally {
    closeSync(fd);
  }
}

export function shebangScripts(ctx: Context): string[] {
  return ctx.tracked().filter((path) => SHEBANG.test(firstLine(join(ctx.root, path))));
}

function shebangs(ctx: Context): Outcome {
  const found = shebangScripts(ctx);
  const problems = [
    ...found.filter((path) => !(path in SHEBANG_ALLOWLIST)).map((path) => `${path} has a python, bash or sh shebang`),
    ...Object.keys(SHEBANG_ALLOWLIST).filter((path) => !found.includes(path)).map((path) => `${path} is allowlisted but is gone or has no such shebang`),
  ];
  return verdict(problems, `${found.length} tracked scripts carry a shebang, each allowlisted with a reason`);
}

function coreImports(ctx: Context): Outcome {
  const files = ctx.tracked().filter((path) => path.startsWith("src/core/") && path.endsWith(".ts") && !path.endsWith(".spec.ts"));
  const problems = files.filter((path) => readText(ctx.root, path).split(/\r?\n/).some((line) => NODE_OR_BUN_IMPORT.test(line))).map((path) => `${path} imports node: or bun:`);
  return verdict(problems, `${files.length} src/core files import nothing from node: or bun:`);
}

function testFileLocation(ctx: Context): Outcome {
  const problems = ctx.tracked().filter((path) => path.endsWith(".test.ts") && !path.startsWith("tests/mod/")).map((path) => `${path} is a *.test.ts outside tests/mod/`);
  return verdict(problems, "every *.test.ts lives in tests/mod/");
}

export const checks: readonly Check[] = [
  { name: "core imports", run: coreImports },
  { name: "test file location", run: testFileLocation },
  { name: "shebang scripts", run: shebangs },
];
