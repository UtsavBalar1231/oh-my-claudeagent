import { closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { type Check, type Context, type Outcome, readText, verdict } from "./core.ts";

const SCRIPT_EXTENSION = /\.(?:py|sh|bash)$/;
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

// `claude plugin eval` runs a case's scaffold_script with bash, and tests/ is never packaged.
const EVAL_SCAFFOLD = /^tests\/plugin-evals\/.+\/fixture\.sh$/;

export function shellOrPythonScripts(ctx: Context): string[] {
  return ctx
    .tracked()
    .filter((path) => !EVAL_SCAFFOLD.test(path) && (SCRIPT_EXTENSION.test(path) || SHEBANG.test(firstLine(join(ctx.root, path)))));
}

function shellOrPython(ctx: Context): Outcome {
  const problems = shellOrPythonScripts(ctx).map((path) => `${path} is a python, bash or sh script`);
  return verdict(problems, "no tracked python, bash or sh script");
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
  { name: "shell and python scripts", run: shellOrPython },
];
