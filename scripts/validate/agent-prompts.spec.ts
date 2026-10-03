import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(REPO, path), "utf8");
const lines = (path: string) => read(path).split(/\r?\n/);

describe("prometheus template structure", () => {
  const headings = (prefix: string) => lines("agents/prometheus.md").filter((line) => line.startsWith(prefix)).length;

  test("prometheus template has no Final Checklist mandate", () => {
    expect(headings("### Final Checklist")).toBe(0);
  });

  test("prometheus template has Completion Signaling subsection", () => {
    expect(headings("### Completion Signaling")).toBe(1);
  });
});

describe("sisyphus orchestration contract", () => {
  const sisyphus = read("agents/sisyphus.md");
  const startWork = read("skills/start-work/SKILL.md");

  test("sisyphus canary: Plan Execution Mode section present in sisyphus.md", () => {
    expect(sisyphus).toContain("## Plan Execution Mode");
  });

  test("sisyphus canary: hard-refuse policy present in sisyphus.md", () => {
    expect(sisyphus.includes("MUST REFUSE") || sisyphus.toLowerCase().includes("no degraded mode")).toBe(true);
  });

  test("sisyphus canary: skills/start-work/SKILL.md carries 5-Section Prompt Structure", () => {
    expect(startWork).toContain("## 5-Section Prompt Structure");
  });

  test("sisyphus canary: skills/start-work/SKILL.md carries Completeness Check section", () => {
    expect(startWork).toContain("## Completeness Check");
  });

  test("sisyphus canary: final_verification evidence type present in skills/start-work/SKILL.md", () => {
    expect(startWork).toContain("final_verification");
  });
});
