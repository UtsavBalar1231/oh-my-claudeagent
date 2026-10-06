import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sha256Hex } from "./sha256.ts";

const bytesOf = (length: number): Uint8Array => Uint8Array.from({ length }, (_unused, index) => (index * 31 + 7) & 0xff);

describe("sha256Hex", () => {
  test.each([0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 170_000])("matches node:crypto for %i bytes", (length) => {
    const bytes = bytesOf(length);
    expect(sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  test("the empty input has the published digest", () => {
    expect(sha256Hex(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("is stable across calls and leaves the input untouched", () => {
    const bytes = bytesOf(200);
    const before = bytes.slice();
    expect([sha256Hex(bytes), sha256Hex(bytes)]).toEqual([sha256Hex(before), sha256Hex(before)]);
    expect(bytes).toEqual(before);
  });
});
