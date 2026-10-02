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
  test: "bun scripts/validate.ts --check claims --check hooks --check mod --check tree --check engine",
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

const ciLeaves = [...new Set(leafSteps("ci"))].sort();

describe("workflow contract", () => {
  test("just ci recipe chain resolves to the expected leaf steps", () => {
    expect(ciLeaves.join(" ")).toBe("test test-bun test-mcp test-mod test-opencode typecheck-ts validate-manifest validate-mod");
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

  test("release.yml runs the claims+hooks validate gate", () => {
    expect(RELEASE.includes(PINS.test ?? "\0")).toBe(true);
  });

  test("release.yml's release job needs the validate gate", () => {
    const needs = RELEASE.split("\n").slice(RELEASE.split("\n").findIndex((line) => line.startsWith("  release:"))).find((line) => line.includes("needs:"));
    expect(needs?.trim()).toBe("needs: [validate]");
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
