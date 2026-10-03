import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { specEnv } from "../tests/fixtures/spec-env.ts";
import { listPackageFiles, main, packageTree, refusal } from "./package.ts";
import { gitTracked } from "./validate/core.ts";

const SHIPPED: Record<string, string> = {
  ".claude-plugin/plugin.json": '{"name":"oh-my-claudeagent","version":"9.9.9"}\n',
  ".gitignore": "x\n",
  "README.md": "readme\n",
  "agents/a.md": "agent\n",
  "docs/guide.md": "guide\n",
  "hooks/hooks.json": "{}\n",
  "scripts/setup-statusline.ts": "ts\n",
  "servers/m.ts": "ts\n",
  "statusline/main.ts": "ts\n",
  ".claude-plugin/types/tsconfig.json": "{}\n",
  "servers/package.json": "{}\n",
};

const EXCLUDED: Record<string, string> = {
  ".github/assets/hero.png": "x",
  ".github/workflows/ci.yml": "x",
  ".omca/state/b.json": "x",
  ".claude/settings.json": "x",
  "benchmarks/perf/r.json": "x",
  "docs/CLAUDE.md": "x",
  "tests/t.spec.ts": "x",
  "servers/tests/y.ts": "x",
  "scripts/package.ts": "x",
  "scripts/validate/core.ts": "x",
  "scripts/qa/lib.ts": "x",
  "servers/m.spec.ts": "x",
  "justfile": "x",
  ".pre-commit-config.yaml": "x",
  ".editorconfig": "x",
  "CONTRIBUTING.md": "x",
  "scripts/docs/screenshots.ts": "x",
  "scripts/docs/fixtures/acme-app/justfile": "x",
  "node_modules/m/index.js": "x",
  "CLAUDE.md": "x",
  "package.json": "{}\n",
  "bun.lock": "x",
  "bunfig.toml": "x",
  "tsconfig.json": "{}\n",
  "tsconfig.runtime.json": "{}\n",
  ".oxlintrc.json": "{}\n",
  "opencode/index.ts": "x",
  "opencode/overlays/executor.md": "x",
  ".opencode/plugin.ts": "x",
  "video/package.json": "{}\n",
  "video/bun.lock": "x",
  "video/src/Root.tsx": "x",
  "video/public/placeholder/hero.png": "x",
};

const UNTRACKED: Record<string, string> = {
  "agents/untracked.md": "x\n",
  "notes.txt": "x\n",
  "scratch/deep/file.ts": "x\n",
};

let root = "";
let dest = "";

function seed(base: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), text);
  }
}

const filesUnder = (base: string): string[] => [...new Bun.Glob("**/*").scanSync({ cwd: base, dot: true, onlyFiles: true })].map((path) => path.replaceAll("\\", "/")).sort();

function git(...args: string[]): void {
  const run = Bun.spawnSync(["git", "-C", root, ...args], { env: specEnv(), stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

beforeEach(() => {
  const scratch = mkdtempSync(join(tmpdir(), "omca-package-spec-"));
  root = join(scratch, "root");
  dest = join(scratch, "dest");
  seed(root, { ...SHIPPED, ...EXCLUDED });
  git("init", "-q");
  git("add", "-A");
  seed(root, UNTRACKED);
});

afterEach(() => {
  rmSync(dirname(root), { recursive: true, force: true });
});

describe("listPackageFiles", () => {
  test("lists exactly the shipped files, sorted, and drops every excluded name at any depth", () => {
    expect(listPackageFiles([".git/HEAD", ...Object.keys(EXCLUDED), ...Object.keys(SHIPPED)])).toEqual(Object.keys(SHIPPED).sort());
  });

  test("drops the root manifests, lockfile, typecheck configs and the OpenCode adapter, and keeps a nested file of the same name", () => {
    const listed = listPackageFiles([
      "package.json",
      "bun.lock",
      "bunfig.toml",
      "tsconfig.json",
      "tsconfig.runtime.json",
      ".oxlintrc.json",
      "opencode/index.ts",
      ".opencode/plugin.ts",
      "servers/package.json",
      "docs/opencode/notes.md",
      ".claude-plugin/types/tsconfig.json",
    ]);
    expect(listed).toEqual([".claude-plugin/types/tsconfig.json", "docs/opencode/notes.md", "servers/package.json"]);
  });

  test("drops every file of the demo video project and keeps a nested video directory", () => {
    const listed = listPackageFiles(["video/package.json", "video/bun.lock", "video/render.ts", "video/src/components/Camera.tsx", "docs/video/notes.md"]);
    expect(listed).toEqual(["docs/video/notes.md"]);
  });
});

describe("packageTree", () => {
  test("copies the listed files with their contents and nothing else", () => {
    const files = packageTree(root, dest);

    expect(files).toEqual(Object.keys(SHIPPED).sort());
    expect(filesUnder(dest)).toEqual(files);
    for (const [path, text] of Object.entries(SHIPPED)) expect(readFileSync(join(dest, path), "utf8")).toBe(text);
  });

  test("packages a tree that is not a repository from the tracked list it is given", () => {
    const exported = join(dirname(root), "exported");
    seed(exported, { ...SHIPPED, ...EXCLUDED, ...UNTRACKED });

    const files = packageTree(exported, dest, [...Object.keys(SHIPPED), ...Object.keys(EXCLUDED)]);

    expect(files).toEqual(Object.keys(SHIPPED).sort());
    expect(filesUnder(dest)).toEqual(Object.keys(SHIPPED).sort());
  });

  test("never ships an untracked file", () => {
    const files = packageTree(root, dest);

    for (const path of Object.keys(UNTRACKED)) {
      expect(files).not.toContain(path);
      expect(existsSync(join(dest, path))).toBe(false);
    }
    expect(filesUnder(dest)).toEqual(Object.keys(SHIPPED).sort());
  });

  test.skipIf(process.platform === "win32")("keeps the executable bit (skipped on Windows: it has no executable bit)", () => {
    chmodSync(join(root, "scripts", "setup-statusline.ts"), 0o755);

    packageTree(root, dest);

    expect(statSync(join(dest, "scripts", "setup-statusline.ts")).mode & 0o777).toBe(0o755);
  });

  test("replaces an earlier copy: stale files and directories go, excluded names stay, a file where a directory belongs is replaced", () => {
    seed(dest, {
      ".claude-plugin/plugin.json": '{"name":"oh-my-claudeagent"}\n',
      "old.txt": "x",
      "gone/deep/x.txt": "x",
      "README.md": "stale readme\n",
      "agents": "a file where the agents directory belongs",
      ".omca/keep": "x",
      "docs/stale.md": "x",
      "scripts/package.ts": "x",
    });

    packageTree(root, dest);

    expect(filesUnder(dest)).toEqual([...Object.keys(SHIPPED), ".omca/keep"].sort());
    expect(readFileSync(join(dest, "README.md"), "utf8")).toBe("readme\n");
    expect(existsSync(join(dest, "gone"))).toBe(false);
  });
});

describe("a destination that packaging would wreck", () => {
  test("refuses the repository and every directory that holds it, and touches nothing", () => {
    const scratch = dirname(root);
    const before = filesUnder(scratch);

    for (const target of [root, scratch, join(root, "agents", "..")]) {
      expect(refusal(root, target)).toBe(`${target} is the repository or a directory that holds it`);
      expect(() => packageTree(root, target)).toThrow(`refusing to package into ${target} is the repository or a directory that holds it`);
    }
    expect(filesUnder(scratch)).toEqual(before);
  });

  test("refuses a non-empty directory that is not an earlier package, and touches nothing", () => {
    seed(dest, { "notes.txt": "mine\n", ".claude-plugin/plugin.json": '{"name":"another-plugin"}\n' });

    expect(() => packageTree(root, dest)).toThrow(`refusing to package into ${dest} is not empty and is not an earlier oh-my-claudeagent package`);
    expect(filesUnder(dest)).toEqual([".claude-plugin/plugin.json", "notes.txt"]);
  });

  test("accepts a missing directory, an empty one and an earlier package", () => {
    expect(refusal(root, dest)).toBeUndefined();
    mkdirSync(dest);
    expect(refusal(root, dest)).toBeUndefined();
    packageTree(root, dest);
    expect(refusal(root, dest)).toBeUndefined();
  });

  test.each([["."], [".."]])("`package.ts %s` run from the repository refuses with exit 1 and touches nothing", (target) => {
    const scratch = dirname(root);
    const before = filesUnder(scratch);

    const outcome = main([target], root, root);

    expect(outcome.code).toBe(1);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toBe(`ERROR: refusing to package into ${join(root, target)} is the repository or a directory that holds it\n`);
    expect(filesUnder(scratch)).toEqual(before);
  });
});

describe("main", () => {
  test("--dry-run prints the file list, one path per line, and writes nothing", () => {
    const outcome = main(["--dry-run"], root);

    expect(outcome).toEqual({ code: 0, stdout: `${Object.keys(SHIPPED).sort().join("\n")}\n`, stderr: "" });
    expect(existsSync(dest)).toBe(false);
  });

  test("copies into <dest> and reports the manifest version", () => {
    const outcome = main([dest], root);

    expect(outcome).toEqual({ code: 0, stdout: `packaging v9.9.9 → ${dest}\n`, stderr: "" });
    expect(filesUnder(dest)).toEqual(Object.keys(SHIPPED).sort());
  });

  test("reports an unknown version when the manifest is unreadable", () => {
    rmSync(join(root, ".claude-plugin", "plugin.json"));

    expect(main([dest], root).stdout).toBe(`packaging vunknown → ${dest}\n`);
  });

  test.each([
    [[], "Missing <dest_dir>"],
    [["--bogus", dest], "Unknown option '--bogus'"],
    [[dest, "--version", "1.2.3"], "Unknown option '--version'"],
    [[dest, "second"], "Unexpected argument: second"],
  ])("rejects %j with exit 1, the problem and the usage", (args, problem) => {
    const outcome = main(args, root);

    expect(outcome.code).toBe(1);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toContain(problem);
    expect(outcome.stderr).toContain("Usage: bun scripts/package.ts <dest_dir>");
    expect(existsSync(dest)).toBe(false);
  });
});

const REPO = join(import.meta.dir, "..");

/** The shipped paths a file names: its relative imports, paths it joins onto its own directory, `${CLAUDE_PLUGIN_ROOT}` paths and the mod modules. */
function namedPaths(file: string, text: string): string[] {
  const from = (base: string, path: string): string => posix.normalize(posix.join(base, path));
  const dir = posix.dirname(file);
  const named = [...text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]*\w)/g)].map((match) => match[1] ?? "");
  if (file.endsWith(".ts")) {
    for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)"(\.\.?\/[^"]+)"/g)) named.push(from(dir, match[1] ?? ""));
    for (const match of text.matchAll(/new URL\("(\.\.?\/[^"]+)", import\.meta\.url\)/g)) named.push(from(dir, match[1] ?? ""));
    for (const match of text.matchAll(/join\(import\.meta\.dir((?:,\s*"[^"]+")+)\)/g)) {
      named.push(from(dir, [...(match[1] ?? "").matchAll(/"([^"]+)"/g)].map((part) => part[1] ?? "").join("/")));
    }
  }
  if (file === "hooks/hooks.json") for (const module of JSON.parse(text).modules ?? []) named.push(from(dir, String(module)));
  return named;
}

describe("the repository tree", () => {
  const shipped = listPackageFiles(gitTracked(REPO));

  test("`bun scripts/package.ts --dry-run` ships the template and the status line setup, and no tests, specs or repository tooling", () => {
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "package.ts"), "--dry-run"], { env: specEnv(), stdout: "pipe", stderr: "pipe" });
    const lines = result.stdout.toString().trimEnd().split("\n");

    expect(result.exitCode).toBe(0);
    expect(lines).toEqual(shipped);
    expect(lines.filter((line) => line.startsWith("scripts/"))).toEqual(["scripts/setup-statusline.ts"]);
    expect(lines.filter((line) => /\.spec\.ts$|(^|\/)tests\//.test(line))).toEqual([]);
    const tooling = /^(package\.json|bun\.lock|bunfig\.toml|tsconfig(\.runtime)?\.json|\.oxlintrc\.json|justfile|\.pre-commit-config\.yaml|\.editorconfig|CONTRIBUTING\.md|\.?opencode\/|video\/)/;
    expect(lines.filter((line) => tooling.test(line))).toEqual([]);
  });

  test("namedPaths reads each form of reference relative to the naming file", () => {
    const text = [
      'import { a } from "../src/core/a.ts";',
      'export * from "./b.ts";',
      'const c = await import("./c.ts");',
      'const d = new URL("../.claude-plugin/plugin.json", import.meta.url);',
      'const e = join(import.meta.dir, "..", "statusline", "launcher.ts");',
      'const f = join(import.meta.dir, `${name}.md`);',
      'run bun "${CLAUDE_PLUGIN_ROOT}/servers/omca.ts".',
    ].join("\n");

    expect(namedPaths("scripts/x.ts", text)).toEqual([
      "servers/omca.ts",
      "src/core/a.ts",
      "scripts/b.ts",
      "scripts/c.ts",
      ".claude-plugin/plugin.json",
      "statusline/launcher.ts",
    ]);
    expect(namedPaths("hooks/hooks.json", '{"modules": ["./register.ts"]}')).toEqual(["hooks/register.ts"]);
  });

  test("every relative import and every path a shipped file names resolves inside the shipped tree", () => {
    const inside = new Set(shipped);
    const dangling = shipped
      .filter((file) => /\.(ts|md|json)$/.test(file) && file !== "CHANGELOG.md")
      .flatMap((file) => namedPaths(file, readFileSync(join(REPO, file), "utf8")).map((path) => `${file} -> ${path}`))
      .filter((reference) => !inside.has(reference.split(" -> ")[1] ?? ""));

    expect(dangling).toEqual([]);
  });
});
