import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(REPO, path), "utf8");
const lines = (path: string) => read(path).split(/\r?\n/);

describe("shared specialist contracts", () => {
  test("executor keeps the report markers its caller and evals consume", () => {
    const executor = read("agents/executor.md");
    expect(executor).toContain("STATUS: complete|blocked|partial");
    expect(executor).toContain("SLOP PASS:");
    expect(executor).toContain("the exact files this task touched");
    expect(executor).toContain("undo only that cut");
  });

  test("Claude memory and worktree guidance stays in host-only sections", () => {
    for (const role of ["architect", "researcher", "reviewer"]) {
      expect(read(`agents/${role}.md`)).toMatch(/## Memory Guidance\n\nUse Claude-native project memory/);
    }
    for (const role of ["executor", "build-fixer"]) {
      expect(read(`agents/${role}.md`)).toMatch(/## Worktree Isolation\n\nWhen launched with `isolation: "worktree"`/);
    }
  });

  test("reviewer edits remain explicitly requested and permission-bound", () => {
    expect(read("agents/reviewer.md")).toContain("Edit a plan or write non-code review notes only when the user explicitly asks and the host permits it");
  });

  test("output style retains Claude's actual result-delivery rules", () => {
    const style = read("output-styles/omca-default.md");
    expect(style).toContain("## Claude Code");
    expect(style).toContain("`<result>` in a `<task-notification>`");
    expect(style).toContain("do not read or tail the child's transcript file");
    expect(style).toContain("foreground tool result");
  });

  test("planning skills refer to an existing output-style section", () => {
    const sections = new Set(lines("output-styles/omca-default.md").filter((line) => line.startsWith("## ")).map((line) => line.slice(3)));
    for (const skill of ["plan", "start-work"]) {
      const references = [...read(`skills/${skill}/SKILL.md`).matchAll(/The OMCA Default output style.*?under "([^"]+)"/g)];
      expect(references).toHaveLength(1);
      for (const reference of references) expect(sections.has(reference[1] ?? "")).toBe(true);
    }
  });

  test("cleanup reference keeps a boundary guard when adversarial proof is unavailable", () => {
    const proof = lines("skills/remove-ai-slops/references/categories.md").find((line) => line.startsWith("**Proof requirement**:"));
    expect(proof).toMatch(/proof is unavailable.*keep the guard/);
    expect(proof).toMatch(/Delete only when equivalent protection is demonstrated/);
  });
});

describe("planner template structure", () => {
  const headings = (prefix: string) => lines("agents/planner.md").filter((line) => line.startsWith(prefix)).length;

  test("planner template has no Final Checklist mandate", () => {
    expect(headings("### Final Checklist")).toBe(0);
  });

  test("planner template has Completion Signaling subsection", () => {
    expect(headings("### Completion Signaling")).toBe(1);
  });
});

describe("orchestrator orchestration contract", () => {
  const orchestrator = read("agents/orchestrator.md");
  const startWork = read("skills/start-work/SKILL.md");

  test("orchestrator canary: Plan Execution Mode section present in orchestrator.md", () => {
    expect(orchestrator).toContain("## Plan Execution Mode");
  });

  test("orchestrator canary: hard-refuse policy present in orchestrator.md", () => {
    expect(orchestrator.includes("MUST REFUSE") || orchestrator.toLowerCase().includes("no degraded mode")).toBe(true);
  });

  test("orchestrator canary: skills/start-work/SKILL.md carries 5-Section Prompt Structure", () => {
    expect(startWork).toContain("## 5-Section Prompt Structure");
  });

  test("orchestrator canary: skills/start-work/SKILL.md carries Completeness Check section", () => {
    expect(startWork).toContain("## Completeness Check");
  });

  test("orchestrator canary: final_verification evidence type present in skills/start-work/SKILL.md", () => {
    expect(startWork).toContain("final_verification");
  });
});
