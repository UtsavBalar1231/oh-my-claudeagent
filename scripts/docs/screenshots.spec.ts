import { describe, expect, test } from "bun:test";
import { normalize, SHOTS } from "./screenshots.ts";

const FAKE_HOME = ["", "home", "someone"].join("/");

describe("SHOTS", () => {
  test("names are unique file stems and every shot fits a real terminal", () => {
    const names = SHOTS.map((shot) => shot.name);
    expect(new Set(names).size).toBe(names.length);
    for (const shot of SHOTS) {
      expect(shot.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(shot.cols).toBeGreaterThanOrEqual(80);
      expect(shot.rows).toBeGreaterThanOrEqual(20);
    }
  });
});

describe("normalize", () => {
  const capture = (screen: string) => ({ screen, forbidden: [FAKE_HOME] });

  test("pads every row to the session width, masks the capture and writes canonical ANSI", () => {
    const out = normalize(capture("\x1b[38;5;246mClaude Code v9.9.9\x1b[39m\nok\n"), 40);
    const rows = out.split("\n").slice(0, 2).map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""));
    expect(rows.map((row) => row.length)).toEqual([40, 40]);
    expect(rows[0]).toStartWith("Claude Code v2.1.288");
    expect(out).toContain("\x1b[0;38;5;246mClaude Code");
  });

  test("keeps trailing blanks that carry a background and pads only after them", () => {
    const out = normalize(capture("\x1b[48;5;235mab    \x1b[0m\n"), 10);
    expect(out.split("\n")[0]).toBe("\x1b[0;48;5;235mab    \x1b[0m    ");
  });

  test("refuses a capture that still shows a path from this machine", () => {
    expect(() => normalize(capture(`cwd ${FAKE_HOME}/acme-app\n`), 40)).toThrow("still holds a value from this machine");
  });
});
