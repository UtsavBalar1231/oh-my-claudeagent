import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { specEnv } from "../tests/fixtures/spec-env.ts";
import { listPackageFiles, main, packageTree } from "./package.ts";

const SHIPPED: Record<string, string> = {
  ".claude-plugin/plugin.json": '{"version":"9.9.9"}\n',
  ".gitignore": "x\n",
  "README.md": "readme\n",
  "agents/a.md": "agent\n",
  "docs/guide.md": "guide\n",
  "hooks/hooks.json": "{}\n",
  "scripts/package.ts": "ts\n",
  "servers/m.ts": "ts\n",
  "statusline/main.ts": "ts\n",
  ".claude-plugin/types/tsconfig.json": "{}\n",
  "servers/package.json": "{}\n",
};

const EXCLUDED: Record<string, string> = {
  ".github/assets/hero.svg": "x",
  ".github/workflows/ci.yml": "x",
  ".omca/state/b.json": "x",
  ".claude/settings.json": "x",
  "benchmarks/perf/r.json": "x",
  "docs/design/d.md": "x",
  "docs/CLAUDE.md": "x",
  "tests/t.spec.ts": "x",
  "servers/tests/y.ts": "x",
  "scripts/qa/lib.ts": "x",
  "scripts/docs/screenshots.ts": "x",
  "scripts/docs/fonts/JetBrainsMono-Regular.ttf": "x",
  "node_modules/m/index.js": "x",
  "CLAUDE.md": "x",
  "package.json": "{}\n",
  "bun.lock": "x",
  "bunfig.toml": "x",
  "tsconfig.json": "{}\n",
  "tsconfig.runtime.json": "{}\n",
  "opencode/index.ts": "x",
  "opencode/overlays/executor.md": "x",
  ".opencode/plugin.ts": "x",
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
      "opencode/index.ts",
      ".opencode/plugin.ts",
      "servers/package.json",
      "docs/opencode/notes.md",
      ".claude-plugin/types/tsconfig.json",
    ]);
    expect(listed).toEqual([".claude-plugin/types/tsconfig.json", "docs/opencode/notes.md", "servers/package.json"]);
  });
});

describe("packageTree", () => {
  test("copies the listed files with their contents and nothing else", () => {
    const files = packageTree(root, dest);

    expect(files).toEqual(Object.keys(SHIPPED).sort());
    expect(filesUnder(dest)).toEqual(files);
    for (const [path, text] of Object.entries(SHIPPED)) expect(readFileSync(join(dest, path), "utf8")).toBe(text);
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
    chmodSync(join(root, "scripts", "package.ts"), 0o755);

    packageTree(root, dest);

    expect(statSync(join(dest, "scripts", "package.ts")).mode & 0o777).toBe(0o755);
  });

  test("replaces an earlier copy: stale files and directories go, excluded names stay, a file where a directory belongs is replaced", () => {
    seed(dest, {
      "old.txt": "x",
      "gone/deep/x.txt": "x",
      "README.md": "stale readme\n",
      "agents": "a file where the agents directory belongs",
      ".omca/keep": "x",
      "docs/stale.md": "x",
    });

    packageTree(root, dest);

    expect(filesUnder(dest)).toEqual([...Object.keys(SHIPPED), ".omca/keep"].sort());
    expect(readFileSync(join(dest, "README.md"), "utf8")).toBe("readme\n");
    expect(existsSync(join(dest, "gone"))).toBe(false);
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

describe("the repository tree", () => {
  test("`bun scripts/package.ts --dry-run` lists the shipped template and not the QA harness or tests", () => {
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "package.ts"), "--dry-run"], { env: process.env, stdout: "pipe", stderr: "pipe" });
    const lines = result.stdout.toString().split("\n");

    expect(result.exitCode).toBe(0);
    expect(lines).toContain("templates/claudemd.md");
    expect(lines).toContain("scripts/package.ts");
    expect(lines.filter((line) => /^scripts\/qa\/|(^|\/)tests\//.test(line))).toEqual([]);
    expect(lines.filter((line) => /^(package\.json|bun\.lock|bunfig\.toml|tsconfig(\.runtime)?\.json|\.?opencode\/)/.test(line))).toEqual([]);
  });
});
