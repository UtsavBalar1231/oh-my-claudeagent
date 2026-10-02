import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const JUSTFILE = readFileSync(join(REPO, "justfile"), "utf8");
const CI = readFileSync(join(REPO, ".github", "workflows", "ci.yml"), "utf8");
const RELEASE = readFileSync(join(REPO, ".github", "workflows", "release.yml"), "utf8");

// Leaf recipe -> the substring ci.yml must contain. A pin is needed wherever ci.yml runs the same
// command differently from the recipe body; each pin is also asserted to be a substring of the
// recipe's own body, so a pin cannot drift from the real command, only from CI's coverage of it.
const PINS: Readonly<Record<string, string>> = {
  validate: "bun scripts/validate.ts",
  "test-mcp": "bun test servers",
  "validate-manifest": "claude plugin validate . --strict",
  "test-opencode": "bun test opencode/",
  "typecheck-ts": "bun x tsc --noEmit -p tsconfig.runtime.json",
  "test-mod": "claude plugin test .",
  "test-bun": "bun test src servers statusline scripts opencode",
  "validate-mod": "claude plugin validate .claude-plugin/plugin.json",
};

const header = (name: string) => JUSTFILE.split("\n").find((line) => line.startsWith(`${name}:`));

function recipeBody(name: string): string[] {
  const lines = JUSTFILE.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${name}:`));
  if (start === -1) return [];
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("\t")) break;
    const text = line.slice(1);
    if (!text.startsWith("#") && text.trim() !== "") body.push(text);
  }
  return body;
}

// A recipe with a body is a leaf; one with only a dependency list expands into its dependencies.
function leafSteps(name: string): string[] {
  if (recipeBody(name).length > 0) return [name];
  const dependencies = (header(name) ?? "").slice((header(name) ?? "").indexOf(":") + 1).split(/\s+/).filter((dep) => dep !== "" && !dep.includes("="));
  return dependencies.length === 0 ? [name] : dependencies.flatMap(leafSteps);
}

function jobBlock(name: string): string {
  const lines = CI.split("\n");
  const rest = lines.slice(lines.findIndex((line) => line.startsWith(`  ${name}:`)) + 1);
  const end = rest.findIndex((line) => /^ {2}[a-zA-Z_-]+:/.test(line));
  return rest.slice(0, end === -1 ? undefined : end).join("\n");
}

const ciLeaves = [...new Set(leafSteps("ci"))].sort();

describe("workflow contract", () => {
  test("just ci recipe chain resolves to the expected leaf steps", () => {
    expect(ciLeaves.join(" ")).toBe("test-bun test-mcp test-mod test-opencode typecheck-ts validate validate-manifest validate-mod");
  });

  test("every just ci leaf step has a pinned ci.yml coverage pattern", () => {
    expect(ciLeaves.filter((step) => PINS[step] === undefined)).toEqual([]);
  });

  test("each pinned pattern is a real substring of its recipe's own body", () => {
    expect(ciLeaves.filter((step) => !recipeBody(step).join("\n").includes(PINS[step] ?? "\0"))).toEqual([]);
  });

  test("ci.yml covers every just ci leaf step's pinned pattern", () => {
    expect(ciLeaves.filter((step) => !CI.includes(PINS[step] ?? "\0"))).toEqual([]);
  });

  test("negative sanity: removing the test-mcp job from a ci.yml copy makes coverage fail", () => {
    const copy: string[] = [];
    let skipping = false;
    for (const line of CI.split("\n")) {
      if (line.startsWith("  test-mcp:")) skipping = true;
      else if (skipping && /^ {2}[a-zA-Z_-]+:/.test(line)) skipping = false;
      if (!skipping) copy.push(line);
    }
    expect(copy.join("\n").includes(PINS["test-mcp"] ?? "\0")).toBe(false);
    expect(CI.includes(PINS["test-mcp"] ?? "\0")).toBe(true);
  });

  test("ci.yml is callable, and release.yml runs it as the gate its release job needs", () => {
    expect(CI).toMatch(/^ {2}workflow_call:/m);
    expect(RELEASE).toContain("uses: ./.github/workflows/ci.yml");
    const lines = RELEASE.split("\n");
    const needs = lines.slice(lines.findIndex((line) => line.startsWith("  release:"))).find((line) => line.includes("needs:"));
    expect(needs?.trim()).toBe("needs: [ci]");
  });

  test("every setup-bun step in ci.yml opts out of the cache, since a tag push runs it through release.yml", () => {
    const steps = CI.split("\n").flatMap((line, index, lines) => (line.includes("oven-sh/setup-bun@") ? [lines.slice(index, index + 4).join("\n")] : []));
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.filter((step) => !step.includes("no-cache: true"))).toEqual([]);
  });

  test("every job but the latest-client manifest check runs on linux, macOS and windows without failing fast", () => {
    for (const job of ["validate", "test-mcp", "test-opencode", "typescript", "smoke"]) {
      const block = jobBlock(job);
      expect(block).toContain("os: [ubuntu-latest, macos-latest, windows-latest]");
      expect(block).toContain("fail-fast: false");
      expect(block).toContain("runs-on: ${{ matrix.os }}");
    }
    expect(jobBlock("validate-manifest")).toContain("runs-on: ubuntu-latest");
  });

  test("ci.yml pins an ast-grep archive digest for each OS and a spec floor that is a whole number", () => {
    for (const os of ["LINUX", "MACOS", "WINDOWS"]) expect(CI).toMatch(new RegExp(`^ {2}AST_GREP_SHA256_${os}: [0-9a-f]{64}$`, "m"));
    expect(CI).toMatch(/^ {2}BUN_SPEC_FLOOR: "[1-9][0-9]*"$/m);
  });

  test("neither workflow runs bats or checks out submodules", () => {
    for (const workflow of [CI, RELEASE]) {
      expect(workflow).not.toContain("bats");
      expect(workflow).not.toContain("submodules");
    }
  });

  test("the justfile defines no bats recipe and the ci recipe names none", () => {
    expect(JUSTFILE).not.toContain("bats");
    expect(ciLeaves).not.toContain("test-bats");
  });
});
