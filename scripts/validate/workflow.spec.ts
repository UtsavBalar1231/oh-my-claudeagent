import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const read = (path: string): string => readFileSync(join(REPO, path), "utf8");
const JUSTFILE = read("justfile");

type Step = { name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown> };
type Job = { "runs-on": string; strategy?: { "fail-fast": boolean; matrix: { os: string[] } }; env?: Record<string, string>; steps: Step[] };
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };

const parse = <T>(path: string): T => Bun.YAML.parse(read(path)) as T;
const CI = parse<Workflow>(".github/workflows/ci.yml");
const RELEASE = parse<Workflow>(".github/workflows/release.yml");
const AST_GREP = parse<{ runs: { steps: Step[] } }>(".github/actions/ast-grep/action.yml");

const job = (name: string): Job => {
  const found = CI.jobs[name];
  if (found === undefined) throw new Error(`ci.yml has no ${name} job`);
  return found;
};

// A recipe header is its name, any parameters, then the colon: `validate *args:` and `ci: lint test`.
const isHeader = (name: string) => (line: string) => new RegExp(`^${name}(?: [^:=]*)?:(?!=)`).test(line);

function recipeBody(name: string): string[] {
  const lines = JUSTFILE.split("\n");
  const start = lines.findIndex(isHeader(name));
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
  const header = JUSTFILE.split("\n").find(isHeader(name)) ?? "";
  const dependencies = header.slice(header.indexOf(":") + 1).split(/\s+/).filter((dep) => dep !== "" && !dep.includes("="));
  return dependencies.length === 0 ? [name] : dependencies.flatMap(leafSteps);
}

const ciLeaves = [...new Set(leafSteps("ci"))].sort();
const SPEC_ROOTS = job("typescript").env?.["BUN_SPEC_ROOTS"] ?? "";

/** Each command a ci.yml step runs, with the spec roots expanded; installs, setup and summaries are not commands under test. */
const ciCommands = Object.values(CI.jobs)
  .flatMap((ci) => ci.steps)
  .filter((step) => step.run !== undefined && !/^(Install|Job summary)/.test(step.name ?? ""))
  .flatMap((step) => (step.run ?? "").split("\n").map((line) => line.trim().replaceAll("$BUN_SPEC_ROOTS", SPEC_ROOTS)))
  .filter((line) => line !== "");

/** The command each line of a `just ci` leaf recipe runs, without its forwarded arguments. */
const recipeCommands = ciLeaves.flatMap((leaf) => recipeBody(leaf).map((line) => line.replace(/\s*\{\{ *\w+ *\}\}/g, "")));

const startsCommand = (command: string, recipe: string): boolean => command === recipe || command.startsWith(`${recipe} `);

const CI_ONLY_REASONS: Readonly<Record<string, string>> = {
  [`bun scripts/qa/junit-complete.ts "$RUNNER_TEMP/bun-junit.xml" ${SPEC_ROOTS}`]: "bun on Windows can crash and exit 0, which only CI's JUnit report shows",
  [`bun test --parallel --randomize --seed=\${{ github.run_number }} ${SPEC_ROOTS}`]: "a fresh seed per run, which a local recipe has no source for",
  "claude plugin validate . --strict": "the latest published client rather than the pinned one",
  "claude plugin validate .claude-plugin/plugin.json --strict": "the latest published client rather than the pinned one",
};

describe("workflow contract", () => {
  test("just ci resolves to the expected leaf recipes", () => {
    expect(ciLeaves).toEqual(["lint", "smoke", "test", "test-mod", "test-opencode", "typecheck", "validate"]);
  });

  test("ci.yml runs every command of every just ci recipe", () => {
    expect(recipeCommands.filter((recipe) => !ciCommands.some((command) => startsCommand(command, recipe)))).toEqual([]);
  });

  test("every command ci.yml runs belongs to a just ci recipe or has a reason to run in CI only", () => {
    const unexplained = ciCommands.filter((command) => !recipeCommands.some((recipe) => startsCommand(command, recipe)) && CI_ONLY_REASONS[command] === undefined);
    expect(unexplained).toEqual([]);
  });

  test("every CI-only entry is still a command ci.yml runs", () => {
    expect(Object.keys(CI_ONLY_REASONS).filter((command) => !ciCommands.includes(command))).toEqual([]);
  });

  test("ci.yml is callable, and release.yml runs it as the gate its release job needs", () => {
    expect(CI.on).toHaveProperty("workflow_call");
    expect(RELEASE.jobs["ci"]).toMatchObject({ uses: "./.github/workflows/ci.yml" });
    expect(RELEASE.jobs["release"]).toMatchObject({ needs: ["ci"] });
  });

  test("the release job checks every version field against the tag and takes its notes from CHANGELOG.md", () => {
    const runs = (RELEASE.jobs["release"]?.steps ?? []).map((step) => step.run ?? "").join("\n");
    for (const field of [".claude-plugin/plugin.json .version", ".claude-plugin/marketplace.json .metadata.version", ".claude-plugin/marketplace.json .plugins[0].version", "package.json .version"]) {
      expect(runs).toContain(`"${field}"`);
    }
    expect(runs).toContain('--notes-file "$RUNNER_TEMP/notes.md"');
    expect(runs).not.toContain("--generate-notes");
  });

  test("every setup-bun step in ci.yml opts out of the cache, since a tag push runs it through release.yml", () => {
    const steps = Object.values(CI.jobs).flatMap((ci) => ci.steps).filter((step) => step.uses?.startsWith("oven-sh/setup-bun@"));
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.filter((step) => step.with?.["no-cache"] !== true)).toEqual([]);
  });

  test("every job but the latest-client manifest check runs on linux, macOS and windows without failing fast", () => {
    for (const name of Object.keys(CI.jobs).filter((name) => name !== "validate-manifest")) {
      expect(job(name).strategy).toEqual({ "fail-fast": false, matrix: { os: ["ubuntu-latest", "macos-latest", "windows-latest"] } });
      expect(job(name)["runs-on"]).toBe("${{ matrix.os }}");
    }
    expect(job("validate-manifest")["runs-on"]).toBe("ubuntu-latest");
  });

  test("ast-grep comes from the local action, which pins an archive digest for each OS", () => {
    const users = Object.entries(CI.jobs).filter(([, ci]) => ci.steps.some((step) => step.uses === "./.github/actions/ast-grep")).map(([name]) => name);
    expect(users.sort()).toEqual(["test-opencode", "typescript"]);
    expect(read(".github/workflows/ci.yml")).not.toContain("ast-grep/releases/download");
    expect(AST_GREP.runs.steps.map((step) => step.if)).toEqual(["runner.os == 'Linux'", "runner.os == 'macOS'", "runner.os == 'Windows'"]);
    expect(read(".github/actions/ast-grep/action.yml").match(/^ {8}AST_GREP_SHA256: [0-9a-f]{64}$/gm)).toHaveLength(3);
  });

  test("the spec run is checked for completeness on the report and the roots the bun test step used", () => {
    const runs = job("typescript").steps.map((step) => step.run ?? "");
    const testRun = runs.map((run) => /^bun test --parallel (\S+) --reporter=junit --reporter-outfile="([^"]+)"$/.exec(run)).find(Boolean);
    const checkRun = runs.map((run) => /^bun scripts\/qa\/junit-complete\.ts "([^"]+)" (\S+)$/.exec(run)).find(Boolean);
    expect(testRun?.[1]).toBe("$BUN_SPEC_ROOTS");
    expect(checkRun?.[1]).toBe(testRun?.[2]);
    expect(checkRun?.[2]).toBe(testRun?.[1]);
    expect(recipeBody("test")).toEqual([`bun test --parallel ${SPEC_ROOTS}`]);
  });

  test("a seeded random-order run on the same roots replaces the file-order run on Linux and puts its seed in the step name", () => {
    const step = job("typescript").steps.find((candidate) => candidate.run?.includes("--randomize"));
    expect(step).toEqual({
      name: "Bun spec tests in random order (seed ${{ github.run_number }})",
      if: "runner.os == 'Linux'",
      run: "bun test --parallel --randomize --seed=${{ github.run_number }} $BUN_SPEC_ROOTS",
    });
    const fileOrder = job("typescript").steps.filter((candidate) => /^bun (test --parallel \$BUN_SPEC_ROOTS|scripts\/qa\/junit-complete\.ts) /.test(candidate.run ?? ""));
    expect(fileOrder.map((candidate) => candidate.if)).toEqual(["runner.os != 'Linux'", "runner.os != 'Linux'"]);
  });

  test("the validate recipe forwards its arguments to the validator", () => {
    expect(JUSTFILE).toContain("\nvalidate *args:\n\tbun scripts/validate.ts {{ args }}\n");
  });
});
