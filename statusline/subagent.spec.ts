import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SUBAGENT = join(import.meta.dir, "subagent.ts");

const R = "\x1b[0m";
const D = "\x1b[90m";
const W = "\x1b[37m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const RED = "\x1b[31m";
const S = ` ${D}·${R} `;

const name = (label: string, glyph = "A:") => `${W}${glyph} ${label}${R}`;
const model = (label: string, glyph = ">") => `${D}${glyph} ${label}${R}`;
const row = (...segments: string[]) => `${segments.join(S)}${R}`;

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omca-subagent-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(stdin: string, env: Record<string, string> = {}): { stdout: string; exitCode: number } {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["COLUMNS", "OMCA_SUBAGENT_STATUSLINE_DUMP"].includes(key)));
  const result = Bun.spawnSync([process.execPath, SUBAGENT], {
    stdin: new TextEncoder().encode(stdin),
    env: { ...inherited, CLAUDE_STATUSLINE_NERD_FONT: "0", ...env },
  });
  return { stdout: result.stdout.toString(), exitCode: result.exitCode };
}

function rows(payload: unknown, env: Record<string, string> = {}): { id: string; content: string }[] {
  const { stdout, exitCode } = run(JSON.stringify(payload), env);
  expect(exitCode).toBe(0);
  return stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const content = (task: Record<string, unknown>, env: Record<string, string> = {}) =>
  rows({ columns: 300, tasks: [{ id: "t1", ...task }] }, env)[0]?.content;

describe("model", () => {
  test.each([
    ["claude-sonnet-5", "Sonnet 5"],
    ["claude-opus-4-8", "Opus 4.8"],
    ["claude-opus-5-5", "Opus 5.5"],
    ["claude-fable-5", "Fable 5"],
    ["claude-haiku-4-5", "Haiku 4.5"],
    ["opus", "Opus"],
    ["sonnet", "Sonnet"],
    ["fable", "Fable"],
    ["haiku", "Haiku"],
    ["best", "best"],
    ["opusplan", "opusplan"],
    ["claude-nova-9-1-2", "claude-nova-9-1-2"],
  ])("the payload model %s reads %s", (id, label) => {
    expect(content({ name: "worker", model: id })).toBe(row(name("worker"), model(label)));
  });

  test("the payload model wins over the agent's frontmatter", () => {
    expect(content({ name: "oh-my-claudeagent:executor", model: "claude-opus-5-5" })).toBe(row(name("executor"), model("Opus 5.5")));
  });

  test.each([
    ["no model", {}],
    ["an empty model", { model: "" }],
  ])("an OMCA agent with %s takes the tier from its frontmatter", (_, extra) => {
    expect(content({ name: "oh-my-claudeagent:executor", ...extra })).toBe(row(name("executor"), model("Sonnet")));
    expect(content({ name: "oh-my-claudeagent:oracle", ...extra })).toBe(row(name("oracle"), model("Fable")));
  });

  test.each([
    ["another plugin's agent", "other-plugin:executor", "executor"],
    ["an OMCA name with no agent file", "oh-my-claudeagent:nobody", "nobody"],
    ["a bare name", "executor", "executor"],
  ])("%s without a payload model renders no model", (_, taskName, label) => {
    expect(content({ name: taskName })).toBe(row(name(label)));
  });
});

describe("name", () => {
  test.each([
    ["a namespace is stripped", { name: "some-plugin:reviewer", label: "fix" }, "reviewer"],
    ["the label stands in for a missing name", { type: "local_agent", label: "probe" }, "probe"],
    ["the type stands in for a missing label", { type: "local_agent" }, "local_agent"],
    ["nothing at all reads agent", {}, "agent"],
  ])("%s", (_, task, label) => {
    expect(content(task)).toBe(row(name(label)));
  });
});

describe("segments", () => {
  test("a full row shows name, model, status, effort and context share in order", () => {
    expect(content({ name: "executor", model: "sonnet", status: "in_progress", effort: "xhigh", tokenCount: 50000, contextWindowSize: 200000 })).toBe(
      row(name("executor"), model("Sonnet"), `${Y}in_progress${R}`, `${Y}E: xhigh${R}`, `${D}25% ctx${R}`),
    );
  });

  test.each([
    ["running", Y],
    ["pending", D],
    ["completed", G],
    ["success", G],
    ["failed", RED],
    ["error", RED],
    ["paused", D],
  ])("status %s has its color", (status, color) => {
    expect(content({ name: "x", status })).toBe(row(name("x"), `${color}${status}${R}`));
  });

  test.each([
    ["a level", " high ", `${Y}E: high${R}`],
    ["a token budget", 32000, `${Y}E: 32.0k${R}`],
  ])("effort as %s renders", (_, effort, segment) => {
    expect(content({ name: "x", effort })).toBe(row(name("x"), segment));
  });

  test.each([
    ["absent", {}],
    ["a boolean", { effort: true }],
    ["a fraction", { effort: 1.5 }],
    ["blank", { effort: "  " }],
  ])("effort that is %s renders nothing", (_, extra) => {
    expect(content({ name: "x", ...extra })).toBe(row(name("x")));
  });

  test("tokens without a window read as a count", () => {
    expect(content({ name: "x", tokenCount: 50000 })).toBe(row(name("x"), `${D}50.0k tok${R}`));
  });

  test("the context share is capped at 100%", () => {
    expect(content({ name: "x", tokenCount: 300000, contextWindowSize: 200000 })).toBe(row(name("x"), `${D}100% ctx${R}`));
  });

  test("a zero token count renders nothing", () => {
    expect(content({ name: "x", tokenCount: 0, contextWindowSize: 200000 })).toBe(row(name("x")));
  });

  test("Nerd Font glyphs replace the ASCII labels", () => {
    expect(content({ name: "oh-my-claudeagent:executor", model: "opus", effort: "low" }, { CLAUDE_STATUSLINE_NERD_FONT: "1" })).toBe(
      row(name("executor", ""), model("Opus", ""), `${Y} low${R}`),
    );
  });
});

describe("width", () => {
  const long = { name: "a".repeat(50) };

  test("the payload columns cut the row", () => {
    expect(rows({ columns: 40, tasks: [{ id: "t1", ...long }] })[0]?.content).toBe(`${W}A: ${"a".repeat(37)}${R}`);
  });

  test("COLUMNS applies when the payload has none", () => {
    expect(rows({ tasks: [{ id: "t1", ...long }] }, { COLUMNS: "30" })[0]?.content).toBe(`${W}A: ${"a".repeat(27)}${R}`);
  });

  test("the payload columns win over COLUMNS", () => {
    expect(rows({ columns: 40, tasks: [{ id: "t1", ...long }] }, { COLUMNS: "30" })[0]?.content).toBe(`${W}A: ${"a".repeat(37)}${R}`);
  });

  describe("segments drop by priority within the width", () => {
    const full = { name: "executor", model: "sonnet", status: "in_progress", effort: "xhigh", tokenCount: 50000, contextWindowSize: 200000 };
    const at = (columns: number): string | undefined => rows({ columns, tasks: [{ id: "t1", ...full }] })[0]?.content;
    const parts = [name("executor"), model("Sonnet"), `${Y}in_progress${R}`, `${Y}E: xhigh${R}`, `${D}25% ctx${R}`];

    test.each([
      [57, 5],
      [56, 4],
      [47, 4],
      [46, 3],
      [36, 3],
      [35, 2],
      [22, 2],
      [21, 1],
    ])("%p columns keep the first %p segments", (columns, kept) => {
      expect(at(columns)).toBe(row(...parts.slice(0, kept)));
    });

    test("a segment is never cut: a lower one is dropped when a higher one does not fit", () => {
      expect(at(50)).toBe(row(...parts.slice(0, 4)));
    });

    test("a name wider than the row is cut alone", () => {
      expect(rows({ columns: 10, tasks: [{ id: "t1", name: "a".repeat(30), model: "opus" }] })[0]?.content).toBe(`${W}A: ${"a".repeat(7)}${R}`);
    });
  });

  test("the width falls back to 80", () => {
    expect(rows({ tasks: [{ id: "t1", name: "a".repeat(100) }] })[0]?.content).toBe(`${W}A: ${"a".repeat(77)}${R}`);
  });
});

describe("stdin contract", () => {
  test("each task with an id gets one row, in order", () => {
    const payload = {
      columns: 300,
      tasks: [{ id: "a1", name: "oh-my-claudeagent:executor", status: "running" }, { name: "no-id" }, null, 7, { id: "a2", name: "oh-my-claudeagent:oracle" }],
    };
    expect(rows(payload)).toEqual([
      { id: "a1", content: row(name("executor"), model("Sonnet"), `${Y}running${R}`) },
      { id: "a2", content: row(name("oracle"), model("Fable")) },
    ]);
  });

  test.each([
    ["input that is not JSON", "{not valid json"],
    ["an empty input", ""],
    ["a payload that is null", "null"],
    ["an empty task list", '{"tasks": []}'],
    ["tasks that are not a list", '{"tasks": {"id": "a"}}'],
  ])("%s prints nothing and exits cleanly", (_, stdin) => {
    expect(run(stdin)).toEqual({ stdout: "", exitCode: 0 });
  });
});

describe("payload dump", () => {
  test("each payload is appended as one line", () => {
    const dump = join(root, "dump.jsonl");
    run('{"tasks": []}\n', { OMCA_SUBAGENT_STATUSLINE_DUMP: dump });
    const second = run('{"tasks": [{"id": "a", "name": "x"}]}', { OMCA_SUBAGENT_STATUSLINE_DUMP: dump });
    expect(readFileSync(dump, "utf8")).toBe('{"tasks": []}\n{"tasks": [{"id": "a", "name": "x"}]}\n');
    expect(second.stdout).toBe(`${JSON.stringify({ id: "a", content: row(name("x")) })}\n`);
  });

  test("a dump path that cannot be written leaves the render intact", () => {
    expect(run('{"tasks": [{"id": "a", "name": "x"}]}', { OMCA_SUBAGENT_STATUSLINE_DUMP: root }).stdout).toBe(
      `${JSON.stringify({ id: "a", content: row(name("x")) })}\n`,
    );
  });
});
