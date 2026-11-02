import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Prompt prose is free to change. These pin only what other code reads: report markers, the evidence
// type, section headings the OpenCode projection drops, and cross-references between prompt files.
const REPO = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(REPO, path), "utf8");

describe("machine-read prompt values", () => {
  test("executor keeps the report markers its caller and evals consume", () => {
    const executor = read("agents/executor.md");
    expect(executor).toContain("STATUS: complete|blocked|partial");
    expect(executor).toContain("SLOP PASS:");
  });

  test("agents keep the host-only headings the OpenCode projection drops", () => {
    for (const role of ["architect", "researcher", "reviewer"]) expect(read(`agents/${role}.md`)).toContain("\n## Memory Guidance\n");
    for (const role of ["executor", "build-fixer"]) expect(read(`agents/${role}.md`)).toContain("\n## Worktree Isolation\n");
  });

  test("start-work logs the evidence type the Stop gate reads", () => {
    expect(read("skills/start-work/SKILL.md")).toContain('evidence_type="final_verification"');
  });

  test("a skill's reference to an output-style section names a section that exists", () => {
    const sections = new Set(read("output-styles/omca-default.md").split(/\r?\n/).filter((line) => line.startsWith("## ")).map((line) => line.slice(3)));
    for (const skill of ["plan", "start-work"]) {
      for (const reference of read(`skills/${skill}/SKILL.md`).matchAll(/The OMCA Default output style.*?under "([^"]+)"/g)) {
        expect(sections.has(reference[1] ?? "")).toBe(true);
      }
    }
  });
});
