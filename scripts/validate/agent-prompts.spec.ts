import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(REPO, path), "utf8");
const lines = (path: string) => read(path).split(/\r?\n/);

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
