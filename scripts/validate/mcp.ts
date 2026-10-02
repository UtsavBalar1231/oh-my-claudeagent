import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asList, asRecord, type Check, type Context, type Outcome, readJson, run, type Run, verdict } from "./core.ts";

const FIXTURES = "tests/fixtures/mcp";
const HANDSHAKE = ["initialize.json", "initialized-notification.json", "tools-list.json"];
const TIMEOUT_MS = 45_000;

export function judgeHandshake(result: Run, expectedTools: readonly string[]): Outcome {
  if (result.code !== 0) {
    const reason = result.stderr.trim().split(/\r?\n/).slice(0, 12).join(" | ");
    return { status: "fail", detail: `the handshake command exited ${result.code}${reason === "" ? "" : ` (${reason})`}` };
  }
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return { status: "fail", detail: "the handshake returned empty stdout" };
  const messages: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      messages.push(asRecord(JSON.parse(line)));
    } catch {
      return { status: "fail", detail: "the handshake stdout is not valid JSON lines" };
    }
  }
  const problems: string[] = [];
  if (!messages.some((message) => message.id === 1)) problems.push("no initialize response");
  const listing = messages.find((message) => message.id === 2);
  if (listing === undefined) problems.push("no tools/list response");
  const names = new Set(asList(asRecord(asRecord(listing).result).tools).map((tool) => asRecord(tool).name));
  for (const tool of expectedTools) if (!names.has(tool)) problems.push(`tools/list is missing ${tool}`);
  return verdict(problems, `initialize and tools/list answered, ${expectedTools.length} expected tools listed`);
}

function readFixtures(ctx: Context): { expected: string[]; input: string } | string {
  let name = "";
  try {
    const json = (file: string): unknown => {
      name = file;
      return readJson(join(ctx.root, FIXTURES, file));
    };
    const expected = asList(json("expected-tools.json")).filter((tool) => typeof tool === "string");
    return { expected, input: HANDSHAKE.map((file) => `${JSON.stringify(json(file))}\n`).join("") };
  } catch (error) {
    return `${FIXTURES}/${name}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function handshake(ctx: Context): Outcome {
  const fixtures = readFixtures(ctx);
  if (typeof fixtures === "string") return { status: "fail", detail: fixtures };
  const { expected, input } = fixtures;
  const scratch = mkdtempSync(join(tmpdir(), "omca-mcp-handshake-"));
  try {
    run(["git", "init", "-q"], scratch);
    return judgeHandshake(run([process.execPath, join(ctx.root, "servers", "omca.ts")], scratch, { input, timeoutMs: TIMEOUT_MS }), expected);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export const checks: readonly Check[] = [{ name: "mcp handshake", run: handshake }];
