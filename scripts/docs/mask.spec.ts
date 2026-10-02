import { describe, expect, test } from "bun:test";
import { formatAnsi, parseAnsi, rowWidth } from "./ansi.ts";
import { CLIENT_VERSION, maskRows, plainText, PLUGIN_VERSION } from "./mask.ts";

const mask = (ans: string, forbidden: readonly string[] = []) => maskRows(parseAnsi(ans), forbidden);
const lines = (ans: string): string[] => mask(ans).map((row) => plainText(row).trimEnd());
const SCRATCH = ["", "tmp", "omca-shots-Ab12Cd", "home"].join("/");
const FAKE_HOME = ["", "home", "someone"].join("/");
const pad = (text: string, cols = 100) => text.padEnd(cols);

describe("masking", () => {
  test.each([
    ["the client version in the banner", " ▐▛███▛█   Claude Code v2.9.99", ` ▐▛███▛█   Claude Code v${CLIENT_VERSION}`],
    ["the client version in the status line", "> Opus 5.5 · * main · v2.9.99", `> Opus 5.5 · * main · v${CLIENT_VERSION}`],
    [
      "the client version and floor in the doctor",
      "9.9.9 meets the 8.8.8 floor",
      `${CLIENT_VERSION} meets the ${CLIENT_VERSION} floor`,
    ],
    ["the plugin version", "oh-my-claudeagent 9.9.9 is loaded", `oh-my-claudeagent ${PLUGIN_VERSION} is loaded`],
    ["the bun version", "bun 9.9.9 is on PATH; Desktop", "bun 1.4.2 is on PATH; Desktop"],
    ["the ast-grep version", "ast-grep 9.9.9 is on PATH", "ast-grep 0.44.1 is on PATH"],
    ["the 12-hour clock", "✻ Worked for 9s · done 11:07 PM", "✻ Worked for 9s · done 9:41 AM"],
    ["the 24-hour clock", "r: Run again   2 info · checked 23:07", "r: Run again   2 info · checked 09:41"],
    ["a turn summary, its verb and its duration", "✻ Cogitated for 1h 2m 33s · done 9:41 AM", "✻ Worked for 9s · done 9:41 AM"],
    ["a turn summary verb with an accent", "✻ Sautéed for 0s · done 9:41 AM", "✻ Worked for 9s · done 9:41 AM"],
    ["a spinner frame", "✢ Waiting for 2 background agents to finish", "✻ Waiting for 2 background agents to finish"],
    ["the footer duration", "● oh-my-claudeagent: 0s · 1 in 1 out", "● oh-my-claudeagent: 9s · 1 in 1 out"],
    ["an agent duration", 'Agent "Fix it" finished · 2m 5s', 'Agent "Fix it" finished · 9s'],
    ["the session duration", "$0.00 · ~ 3m 12s · 2 tok · api 4s", "$0.00 · ~ 0m 9s · 2 tok · api 9s"],
    ["a scratch directory path", `cwd ${SCRATCH}/dev/acme-app`, "cwd ~/dev/acme-app"],
  ])("replaces %s", (_name, before, after) => {
    expect(lines(pad(before))).toEqual([after]);
  });

  test("leaves text that is not a captured value alone", () => {
    const text = "Task 7 took 4s to read v1 of the plan at 3:15";
    expect(lines(pad(text))).toEqual([text]);
  });

  test("keeps a bordered row the same width and the border in its column", () => {
    const before = `${"● Agent finished · 12m 5s".padEnd(30)}│ pane`;
    const [row] = mask(pad(before));
    expect(row === undefined ? 0 : rowWidth(row)).toBe(100);
    expect(plainText(row ?? []).indexOf("│")).toBe(30);
    expect(plainText(row ?? []).startsWith("● Agent finished · 9s")).toBe(true);
  });

  test("gives a result that does not depend on how wide the original value was", () => {
    const short = lines(pad("● oh-my-claudeagent: 1s · rest")).join();
    const long = lines(pad("● oh-my-claudeagent: 1h 20m 33s · rest")).join();
    expect(short).toBe(long);
  });

  test("keeps the style of the replaced cells", () => {
    const [row] = mask(pad("\x1b[2mdone 1:02 AM\x1b[0m"));
    expect(row?.slice(5, 12).every((cell) => cell.style.dim)).toBe(true);
  });

  test("a second pass changes nothing", () => {
    const once = formatAnsi(mask(pad("✻ Churned for 0s · done 1:02 AM")));
    expect(formatAnsi(mask(once))).toBe(once);
  });

  test("fails when a mask would widen a row that has no gap to give", () => {
    expect(() => mask("✻ Gc for 1s")).toThrow(/widens a row/);
  });
});

describe("the machine check", () => {
  test("fails on a value from this machine and does not print it", () => {
    const attempt = () => mask(pad(`cwd ${FAKE_HOME}/acme-app`), [FAKE_HOME]);
    expect(attempt).toThrow("row 1 still holds a value from this machine");
    expect(attempt).not.toThrow("someone");
  });

  test("ignores values too short to identify anything", () => {
    expect(() => mask(pad("cwd /acme-app"), ["acm"])).not.toThrow();
  });

  test("passes when nothing from the machine is left", () => {
    expect(() => mask(pad("cwd ~/dev/acme-app"), [FAKE_HOME, "someone"])).not.toThrow();
  });
});
