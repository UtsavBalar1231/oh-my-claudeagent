#!/usr/bin/env bun
import { join } from "node:path";
import { isRecord } from "../src/core/tool-input.ts";

const CONTEXT_LINES = 20;

export type Typecheck = () => { ok: boolean; output: string };

function editedTypeScript(stdin: string): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(stdin);
  } catch {
    return false;
  }
  const input = isRecord(payload) ? payload.tool_input : undefined;
  const file = isRecord(input) ? input.file_path : undefined;
  return typeof file === "string" && file.endsWith(".ts");
}

/** The PostToolUse hook output for one edit: empty unless the edit was a `.ts` file that breaks the typecheck. */
export function report(stdin: string, typecheck: Typecheck): string {
  if (!editedTypeScript(stdin)) return "";
  const { ok, output } = typecheck();
  if (ok) return "";
  const additionalContext = output.split("\n").slice(0, CONTEXT_LINES).join("\n");
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } });
}

function justTypecheck(): ReturnType<Typecheck> {
  const run = Bun.spawnSync(["just", "typecheck"], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  return { ok: run.exitCode === 0, output: `${run.stdout.toString()}${run.stderr.toString()}` };
}

if (import.meta.main) {
  void Bun.stdin.text().then((stdin) => {
    const out = report(stdin, justTypecheck);
    if (out !== "") process.stdout.write(`${out}\n`);
  });
}
