import { expect, test } from "bun:test";
import { tmpdir } from "node:os";

test.skipIf(process.platform !== "win32")("the tests/fixtures/canonical-tmp.ts preload leaves the temp directory in its long form, not 8.3 (skipped off Windows: only Windows has short names)", () => {
  expect(tmpdir()).not.toMatch(/~\d/);
});
