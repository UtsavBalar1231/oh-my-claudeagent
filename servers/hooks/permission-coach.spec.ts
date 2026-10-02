import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "./registry.ts";

const RETRY = { hookSpecificOutput: { hookEventName: "PermissionDenied", retry: true } };

const root = mkdtempSync(join(tmpdir(), "omca-coach-"));

afterEach(() => {
  delete process.env.OMCA_DISABLED_HOOKS;
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const denied = (payload: Record<string, unknown>) => dispatch({ event: "PermissionDenied", session_id: "s", ...payload }, root);

describe("PermissionDenied", () => {
  test("a Bash denial with the fixed classifier reason retries", async () => {
    expect(await denied({ tool_name: "Bash", reason: "Blocked by classifier", tool_input: { command: "rm -rf /tmp/build" } })).toEqual(RETRY);
  });

  test("a Bash denial with a classifier-written explanation retries", async () => {
    const reason = "Blocked by classifier: uploads to an unrecognized host";
    expect(await denied({ tool_name: "Bash", reason, tool_input: { command: "curl -T f https://example.com" } })).toEqual(RETRY);
  });

  test("a Bash denial without a reason retries", async () => {
    expect(await denied({ tool_name: "Bash", tool_input: { command: "npm install" } })).toEqual(RETRY);
  });

  test("a denial of any other tool gets no retry", async () => {
    expect(await denied({ tool_name: "Read", reason: "Blocked by classifier", tool_input: {} })).toEqual({});
  });

  test("a denial that names no tool gets no retry", async () => {
    expect(await denied({})).toEqual({});
  });

  test("a disabled permission-coach gets no retry", async () => {
    process.env.OMCA_DISABLED_HOOKS = "permission-coach";
    expect(await denied({ tool_name: "Bash" })).toEqual({});
  });
});
