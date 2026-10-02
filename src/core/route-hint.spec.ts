import { describe, expect, test } from "bun:test";
import { parseRouteHint, type RouteHint } from "./route-hint.ts";

const TASK = "Read README.md.\nReport the title.";

describe("fields", () => {
  test("a hint with no fields is stripped and sets nothing", () => {
    expect(parseRouteHint(`[omca-route]\n${TASK}`)).toEqual({ prompt: TASK, effort: null, ignored: [] });
  });

  test.each(["low", "medium", "high", "xhigh", "max"] as const)("effort=%s is accepted and stripped", (effort) => {
    expect(parseRouteHint(`[omca-route effort=${effort}]\n${TASK}`)).toEqual({ prompt: TASK, effort, ignored: [] });
  });

  test("a later effort wins", () => {
    expect(parseRouteHint(`[omca-route effort=low effort=high]\n${TASK}`)).toEqual({
      prompt: TASK,
      effort: "high",
      ignored: [],
    });
  });
});

describe("unknown fields", () => {
  test.each(["sonnet", "opus", "fable"])("model=%s is an unknown key: ignored, reported, and the line stripped", (model) => {
    expect(parseRouteHint(`[omca-route model=${model}]\n${TASK}`)).toEqual({
      prompt: TASK,
      effort: null,
      ignored: [`model=${model}`],
    });
  });

  test("an effort survives beside a model field in either order", () => {
    const expected: RouteHint = { prompt: TASK, effort: "max", ignored: ["model=fable"] };
    expect(parseRouteHint(`[omca-route effort=max model=fable]\n${TASK}`)).toEqual(expected);
    expect(parseRouteHint(`[omca-route model=fable effort=max]\n${TASK}`)).toEqual(expected);
  });

  test("an unknown effort or key is ignored and reported in order, and the line is still stripped", () => {
    expect(parseRouteHint(`[omca-route effort=extreme effort=LOW temperature=0]\n${TASK}`)).toEqual({
      prompt: TASK,
      effort: null,
      ignored: ["effort=extreme", "effort=LOW", "temperature=0"],
    });
  });
});

describe("whitespace", () => {
  test("extra spaces and tabs around and between fields are accepted", () => {
    expect(parseRouteHint(`  [omca-route \t effort=medium    model=sonnet  ]\t \n${TASK}`)).toEqual({
      prompt: TASK,
      effort: "medium",
      ignored: ["model=sonnet"],
    });
  });

  test("a CRLF line ending is stripped with the line", () => {
    expect(parseRouteHint(`[omca-route effort=xhigh]\r\n${TASK}`)).toEqual({ prompt: TASK, effort: "xhigh", ignored: [] });
  });

  test("a prompt that is only the hint line strips to the empty prompt", () => {
    expect(parseRouteHint("[omca-route effort=low]")).toEqual({ prompt: "", effort: "low", ignored: [] });
  });
});

describe("no hint", () => {
  test("a prompt without a hint line returns undefined", () => {
    expect(parseRouteHint(TASK)).toBeUndefined();
    expect(parseRouteHint("")).toBeUndefined();
  });

  test("a hint that is not on the first line is ignored", () => {
    expect(parseRouteHint(`Read README.md.\n[omca-route effort=low]\nReport the title.`)).toBeUndefined();
    expect(parseRouteHint(`\n[omca-route effort=low]\n${TASK}`)).toBeUndefined();
  });

  test.each([
    "[omca-route effort=low",
    "omca-route effort=low]",
    "[omca-route effort]",
    "[omca-route effort=]",
    "[omca-route =low]",
    "[omca-route effort==low]",
    "[omca-routeeffort=low]",
    "[omca-route effort=low] Read README.md.",
    "[OMCA-ROUTE effort=low]",
  ])("the malformed line %p is left in the prompt", (line) => {
    expect(parseRouteHint(`${line}\n${TASK}`)).toBeUndefined();
  });
});
