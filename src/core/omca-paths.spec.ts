import { expect, test } from "bun:test";
import { statusPath, verificationOf } from "./omca-paths.ts";

test("the status path is under the root's session directory for a safe id and absent otherwise", () => {
  expect(statusPath("/work", "00000000-0000-4000-8000-000000000001")).toBe(
    "/work/.omca/state/session/00000000-0000-4000-8000-000000000001.json",
  );
  for (const id of ["", "../x", "a/b", "nul", ".hidden"]) expect(statusPath("/work", id), id).toBeUndefined();
});

test("a verification needs a string command and a numeric time", () => {
  expect(verificationOf({ verification: { command: "just ci", at: 5, exit_code: 0 } })).toEqual({ command: "just ci", at: 5 });
  for (const status of [null, "x", {}, { verification: null }, { verification: { command: "x" } }, { verification: { command: 1, at: 5 } }, { verification: { command: "x", at: "5" } }]) {
    expect(verificationOf(status), JSON.stringify(status)).toBeNull();
  }
});
