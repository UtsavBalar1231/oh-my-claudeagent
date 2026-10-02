import { describe, expect, test } from "bun:test";
import { CONTEXT_BUDGET, docPart, pack, parseRule, RULE_BODY_CAP, rulePart } from "./rules.ts";

describe("parseRule", () => {
  test("the first line names the pattern and the rest is the body, trailing newlines dropped", () => {
    expect(parseRule("# pattern: *.py\nUse snake_case.\nNo globals.\n\n")).toEqual({
      pattern: "*.py",
      body: "Use snake_case.\nNo globals.",
      isTruncated: false,
    });
  });

  test("CRLF line endings leave no carriage return in the pattern or the body", () => {
    expect(parseRule("# pattern: *.py\r\nUse snake_case.\r\nNo globals.\r\n\r\n")).toEqual({
      pattern: "*.py",
      body: "Use snake_case.\nNo globals.",
      isTruncated: false,
    });
  });

  test("a leading byte-order mark does not hide the pattern header", () => {
    expect(parseRule("\uFEFF# pattern: *.py\nUse snake_case.\n")).toEqual({
      pattern: "*.py",
      body: "Use snake_case.",
      isTruncated: false,
    });
    expect(parseRule("\uFEFF# pattern: *.py\r\nbody\r\n")?.pattern).toBe("*.py");
  });

  test("a body over the cap is cut to the cap and marked truncated", () => {
    expect(parseRule(`# pattern: *.py\n${"x".repeat(RULE_BODY_CAP + 1)}`)).toEqual({
      pattern: "*.py",
      body: "x".repeat(RULE_BODY_CAP),
      isTruncated: true,
    });
  });

  test("a body exactly at the cap is not truncated", () => {
    expect(parseRule(`# pattern: *.py\n${"x".repeat(RULE_BODY_CAP)}\n`)?.isTruncated).toBe(false);
  });

  test("a file without a pattern header on its first line is not a rule", () => {
    expect(parseRule("Runtime rule files live here.\n# pattern: *.py\nbody")).toBeUndefined();
    expect(parseRule("#pattern: *.py\nbody")).toBeUndefined();
    expect(parseRule("# pattern: \nbody")).toBeUndefined();
  });

  test("a blank body is no rule, so an empty override switches a rule off", () => {
    expect([parseRule("# pattern: *.py"), parseRule("# pattern: *.py\n\n  \n")]).toEqual([undefined, undefined]);
  });

  test("the rule part labels the pattern and names the path only when truncated", () => {
    const short = parseRule("# pattern: *.tsx\nUse functional components only.");
    const long = parseRule(`# pattern: *.tsx\n${"y".repeat(RULE_BODY_CAP + 5)}`);
    if (short === undefined || long === undefined) throw new Error("fixture rules must parse");
    expect(rulePart(short, "/p/.omca/rules/react.md")).toEqual({
      path: "/p/.omca/rules/react.md",
      text: "[Rule: *.tsx]: Use functional components only.",
    });
    expect(rulePart(long, "/p/.omca/rules/long.md").text).toBe(
      `[Rule: *.tsx]: ${"y".repeat(RULE_BODY_CAP)} (truncated, read full rule at /p/.omca/rules/long.md)`,
    );
  });
});

describe("docPart", () => {
  const doc = { name: "AGENTS.md", dir: "/p/sub", path: "/p/sub/AGENTS.md" };

  test("a short file is quoted whole under its name and directory", () => {
    expect(docPart(doc, "# Guide\nUse the helpers.\n")).toEqual({ path: doc.path, text: "[AGENTS.md from /p/sub]: # Guide\nUse the helpers." });
  });

  test("a long file is cut before the first line that would pass the cap, with a note naming the file", () => {
    const line = "z".repeat(999);
    expect(docPart(doc, `${line}\n${line}\n${line}\n`).text).toBe(
      `[AGENTS.md from /p/sub]: ${line}\n${line} (truncated, read full file at /p/sub/AGENTS.md)`,
    );
  });

  test("a file whose lines fill the cap exactly is not truncated", () => {
    const line = "z".repeat(999);
    expect(docPart(doc, `${line}\n${line}\n`).text).toBe(`[AGENTS.md from /p/sub]: ${line}\n${line}`);
  });

  test("a single line over the cap leaves an empty excerpt and the note", () => {
    expect(docPart(doc, "x".repeat(2500)).text).toBe("[AGENTS.md from /p/sub]:  (truncated, read full file at /p/sub/AGENTS.md)");
  });
});

describe("pack", () => {
  const part = (path: string, size: number) => ({ path, text: "w".repeat(size) });

  test("parts that fit are joined by newlines and all kept", () => {
    const parts = [part("/a", 3), part("/b", 2)];
    const { context, kept } = pack(parts);
    expect(context).toBe("www\nww");
    expect([...kept]).toEqual(parts);
  });

  test("a part past the budget is deferred and named, and a later part that fits is still kept", () => {
    const big = part("/big", 7000);
    const huge = part("/huge", 1000);
    const small = part("/small", 10);
    const { context, kept } = pack([big, huge, small]);
    expect(context).toBe(`${big.text}\n${small.text}\n[context budget reached, 1 item(s) deferred to a later event: /huge]`);
    expect([...kept]).toEqual([big, small]);
  });

  test("the marker names deferred paths only while the whole context stays within the budget", () => {
    const filler = part("/filler", 7500);
    const deferred = Array.from({ length: 40 }, (_, i) => part(`/deferred/${String(i).padStart(2, "0")}${"/x".repeat(10)}`, 500));
    const { context, kept } = pack([filler, ...deferred]);
    expect([...kept]).toEqual([filler]);
    expect(context.length + 1).toBeLessThanOrEqual(CONTEXT_BUDGET);
    const marker = context.slice(filler.text.length + 1);
    expect(marker.startsWith("[context budget reached, 40 item(s) deferred to a later event: /deferred/00")).toBe(true);
    const named = marker.slice(0, -1).split(" ").filter((word) => word.startsWith("/deferred/"));
    expect(named).toEqual(deferred.slice(0, named.length).map(({ path }) => path));
    const next = deferred[named.length];
    if (next === undefined) throw new Error("every deferred path was named; the fixture no longer tests the cut");
    expect(context.length + 1 + next.path.length + 1).toBeGreaterThan(CONTEXT_BUDGET);
  });

  test("no parts pack to an empty context", () => {
    expect(pack([]).context).toBe("");
  });
});
