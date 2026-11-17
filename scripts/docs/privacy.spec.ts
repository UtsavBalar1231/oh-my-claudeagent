import { describe, expect, test } from "bun:test";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import { assertPrivate, machineValues, SCRATCH_PREFIX } from "./privacy.ts";

const FAKE_HOME = ["", "home", "someone"].join("/");
const REFUSED = "the screen shows a value from this machine (forbidden value 1); refusing to capture it";

describe("machineValues", () => {
  test("lists the scratch path, its random name, the home path, the username and the hostname", () => {
    const scratch = join("/tmp", `${SCRATCH_PREFIX}Ab12Cd`);
    expect(machineValues(scratch)).toEqual([scratch, "Ab12Cd", homedir(), userInfo().username, hostname()]);
  });
});

describe("assertPrivate", () => {
  test("refuses a screen that shows a forbidden value and does not print it", () => {
    const attempt = () => assertPrivate(`cwd ${FAKE_HOME}/acme-app`, [FAKE_HOME]);
    expect(attempt).toThrow(REFUSED);
    expect(attempt).not.toThrow("someone");
  });

  test("names the value by its position in the list", () => {
    expect(() => assertPrivate("signed in as someone", ["Ab12Cd", "someone"])).toThrow("(forbidden value 2)");
  });

  test("matches regardless of case", () => {
    expect(() => assertPrivate("Welcome back, Someone", ["someone"])).toThrow(REFUSED);
  });

  test("refuses a value that wraps onto the next row", () => {
    expect(() => assertPrivate("path /home/some\n  one/acme-app", [FAKE_HOME])).toThrow(REFUSED);
  });

  test("ignores values too short to identify anything", () => {
    expect(() => assertPrivate("cwd /acme-app", ["acm"])).not.toThrow();
  });

  test("passes the public marketplace slug on one row", () => {
    expect(() => assertPrivate("  ✔ added marketplace: UtsavBalar1231/oh-my-claudeagent", ["utsav", "utsavbalar1231"])).not.toThrow();
  });

  test("refuses a bare username", () => {
    expect(() => assertPrivate("signed in as utsav", ["utsav"])).toThrow(REFUSED);
  });

  test("refuses the slug wrapped right after the username", () => {
    expect(() => assertPrivate("clone https://github.com/UtsavBalar1231/\noh-my-claudeagent.git", ["utsav"])).toThrow(REFUSED);
  });

  test("passes a screen that shows only the staged values", () => {
    expect(() => assertPrivate("~/acme-app · main", [FAKE_HOME, "someone", "Ab12Cd"])).not.toThrow();
  });
});
