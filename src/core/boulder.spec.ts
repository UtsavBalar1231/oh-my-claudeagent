import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalize, resolveBoundPlan } from "./boulder.ts";

const FIXTURES = join(import.meta.dir, "../../tests/fixtures/boulder-schemas");

const rawFixture = (name: string): string =>
  readFileSync(join(FIXTURES, `${name}.json`), "utf8");

const fixture = (name: string): Record<string, unknown> => JSON.parse(rawFixture(name));

// The reader's contract: a file that does not parse is an empty registry.
const readOrEmpty = (name: string): unknown => {
  try {
    return JSON.parse(rawFixture(name));
  } catch {
    return {};
  }
};

const PLAN_A = {
  plan_name: "plan-a",
  active_plan: "/home/user/.claude/plans/plan-a.md",
  worktree_path: "",
};
const PLAN_B = {
  plan_name: "plan-b",
  active_plan: "/home/user/.claude/plans/plan-b.md",
  worktree_path: "",
};
const LEGACY = {
  plan_name: "legacy-plan",
  active_plan: "/home/user/.claude/plans/legacy-plan.md",
  worktree_path: "",
};

function plansWith(name: string) {
  return { [name]: { active_plan: `/p/${name}.md`, started_at: "2026-01-01T00:00:00Z" } };
}

function twoPlansBoundTo(planName: string) {
  const data = fixture("two-plan");
  data["bindings"] = { "sess-x": { plan_name: planName, bound_at: 1 } };
  return data;
}

describe("resolveBoundPlan lenient", () => {
  test("an explicit binding wins over the most recent plan", () => {
    expect(resolveBoundPlan(twoPlansBoundTo("plan-a"), "sess-x")).toEqual(PLAN_A);
  });

  test("an unbound session gets the sole registered plan", () => {
    expect(resolveBoundPlan(fixture("single-plan"), "unknown-session")).toEqual(PLAN_A);
  });

  test("an unbound session among several plans gets the latest started_at", () => {
    expect(resolveBoundPlan(fixture("two-plan"), "unknown-session")).toEqual(PLAN_B);
  });

  test("the first plan wins a tie on started_at", () => {
    const stamp = "2026-05-01T00:00:00Z";
    const data = {
      plans: {
        first: { active_plan: "/p/first.md", started_at: stamp },
        second: { active_plan: "/p/second.md", started_at: stamp },
      },
      bindings: {},
    };
    expect(resolveBoundPlan(data, "s")).toEqual({
      plan_name: "first",
      active_plan: "/p/first.md",
      worktree_path: "",
    });
  });

  test("a plan without started_at loses to one with it", () => {
    const data = {
      plans: {
        undated: { active_plan: "/p/undated.md" },
        dated: { active_plan: "/p/dated.md", started_at: "2026-01-01T00:00:00Z" },
      },
      bindings: {},
    };
    expect(resolveBoundPlan(data, "s")).toEqual({
      plan_name: "dated",
      active_plan: "/p/dated.md",
      worktree_path: "",
    });
  });

  test("an empty registry resolves to nothing", () => {
    expect(resolveBoundPlan({ plans: {}, bindings: {} }, "sess-x")).toEqual({});
  });

  test("the old flat schema resolves through the sole-plan fallback", () => {
    expect(resolveBoundPlan(fixture("old-flat"), "unbound-session")).toEqual(LEGACY);
  });

  test("a binding to a missing plan falls through to the sole plan", () => {
    const data = fixture("single-plan");
    data["bindings"] = { "sess-x": { plan_name: "ghost", bound_at: 1 } };
    expect(resolveBoundPlan(data, "sess-x")).toEqual(PLAN_A);
  });

  test("a binding to a missing plan falls through to the most recent plan", () => {
    expect(resolveBoundPlan(twoPlansBoundTo("ghost"), "sess-x")).toEqual(PLAN_B);
  });

  test("the worktree path of a bound plan is returned", () => {
    const data = {
      plans: { wt: { active_plan: "/p/wt.md", worktree_path: "/repo/.claude/worktrees/wt" } },
      bindings: { s: { plan_name: "wt", bound_at: 1 } },
    };
    expect(resolveBoundPlan(data, "s")).toEqual({
      plan_name: "wt",
      active_plan: "/p/wt.md",
      worktree_path: "/repo/.claude/worktrees/wt",
    });
  });

  test("a plan entry without active_plan resolves with an empty path", () => {
    const data = { plans: { bare: {} }, bindings: { s: { plan_name: "bare" } } };
    expect(resolveBoundPlan(data, "s")).toEqual({
      plan_name: "bare",
      active_plan: "",
      worktree_path: "",
    });
  });
});

describe("resolveBoundPlan strict", () => {
  test("an explicit binding resolves", () => {
    expect(resolveBoundPlan(twoPlansBoundTo("plan-a"), "sess-x", true)).toEqual(PLAN_A);
  });

  test("an unbound session gets nothing even with a sole plan", () => {
    expect(resolveBoundPlan(fixture("single-plan"), "unknown-session", true)).toEqual({});
  });

  test("an unbound session gets nothing among several plans", () => {
    expect(resolveBoundPlan(fixture("two-plan"), "unknown-session", true)).toEqual({});
  });

  test("the old flat schema never resolves, because migration creates no bindings", () => {
    expect(resolveBoundPlan(fixture("old-flat"), "unbound-session", true)).toEqual({});
  });

  test("a binding to a missing plan gets nothing", () => {
    expect(resolveBoundPlan(twoPlansBoundTo("ghost"), "sess-x", true)).toEqual({});
  });

  test("an empty session id never matches a binding stored under an empty key", () => {
    const data = { plans: plansWith("plan-a"), bindings: { "": { plan_name: "plan-a" } } };
    expect(resolveBoundPlan(data, "", true)).toEqual({});
  });

  test("an inherited object key is not read as a plan name", () => {
    const data = {
      plans: plansWith("plan-a"),
      bindings: { s: { plan_name: "toString" } },
    };
    expect(resolveBoundPlan(data, "constructor", true)).toEqual({});
    expect(resolveBoundPlan(data, "s", true)).toEqual({});
  });
});

describe("resolveBoundPlan on unreadable files", () => {
  test.each(["corrupt", "half-written"])("%s fixture does not parse", (name) => {
    expect(() => JSON.parse(rawFixture(name))).toThrow(SyntaxError);
  });

  test.each(["corrupt", "half-written"])("%s fixture resolves to nothing", (name) => {
    expect(resolveBoundPlan(readOrEmpty(name), "any-session")).toEqual({});
    expect(resolveBoundPlan(readOrEmpty(name), "any-session", true)).toEqual({});
  });
});

describe("resolveBoundPlan purity", () => {
  test("resolving the old flat fixture leaves the input unchanged", () => {
    const data = fixture("old-flat");
    const before = structuredClone(data);
    resolveBoundPlan(data, "sess-legacy-1");
    expect(data).toEqual(before);
  });
});

describe("normalize", () => {
  test("the old flat fixture becomes a one-plan registry with no bindings", () => {
    expect(normalize(fixture("old-flat"))).toEqual({
      plans: {
        "legacy-plan": {
          active_plan: "/home/user/.claude/plans/legacy-plan.md",
          started_at: "2026-01-01T00:00:00Z",
          session_ids: ["sess-legacy-1", "sess-legacy-2"],
          agent: "sisyphus",
        },
      },
      bindings: {},
    });
  });

  test("a flat file's worktree_path is kept when non-empty", () => {
    const flat = { ...fixture("old-flat"), worktree_path: "/repo/.claude/worktrees/legacy" };
    expect(normalize(flat).plans["legacy-plan"]?.worktree_path).toBe(
      "/repo/.claude/worktrees/legacy",
    );
  });

  test("a flat file with only the required keys gets the defaults", () => {
    expect(normalize({ active_plan: "/p/x.md", plan_name: "x" })).toEqual({
      plans: { x: { active_plan: "/p/x.md", started_at: "", session_ids: [], agent: "sisyphus" } },
      bindings: {},
    });
  });

  test("a flat file without plan_name becomes an empty registry", () => {
    expect(normalize({ active_plan: "/p/x.md", started_at: "2026-01-01T00:00:00Z" })).toEqual({
      plans: {},
      bindings: {},
    });
  });

  test("migrated session_ids are a copy of the input list", () => {
    const flat = fixture("old-flat");
    normalize(flat).plans["legacy-plan"]?.session_ids?.push("intruder");
    expect(flat["session_ids"]).toEqual(["sess-legacy-1", "sess-legacy-2"]);
  });

  test("an active_plan next to a plans key is a registry, not a flat file", () => {
    expect(normalize({ active_plan: "/p/x.md", plan_name: "x", plans: {} })).toEqual({
      plans: {},
      bindings: {},
    });
  });

  test("a registry fixture passes through unchanged", () => {
    const registry = fixture("two-plan");
    expect<unknown>(normalize(registry)).toEqual(registry);
  });

  test.each([
    ["null", null],
    ["an array", []],
    ["a string", "plans"],
    ["a number", 7],
    ["an empty object", {}],
  ])("%s becomes an empty registry", (_label, input) => {
    expect(normalize(input)).toEqual({ plans: {}, bindings: {} });
  });

  test("a non-object plans or bindings value is replaced by an empty one", () => {
    expect(normalize({ plans: [], bindings: "x" })).toEqual({ plans: {}, bindings: {} });
  });

  test("the half-written fixture normalizes to an empty registry via the reader fallback", () => {
    expect(normalize(readOrEmpty("half-written"))).toEqual({ plans: {}, bindings: {} });
  });
});
