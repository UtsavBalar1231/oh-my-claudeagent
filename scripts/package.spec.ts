import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listPackageFiles, main, packageTree } from "./package.ts";

const SHIPPED: Record<string, string> = {
  ".claude-plugin/plugin.json": '{"version":"9.9.9"}\n',
  ".gitignore": "x\n",
  "README.md": "readme\n",
  "agents/a.md": "agent\n",
  "docs/guide.md": "guide\n",
  "hooks/hooks.json": "{}\n",
  "scripts/package.ts": "ts\n",
  "servers/m.py": "py\n",
  "statusline/main.ts": "ts\n",
};

const EXCLUDED: Record<string, string> = {
  ".git/HEAD": "x",
  ".omc/a": "x",
  ".omca/state/b.json": "x",
  ".mypy_cache/a": "x",
  ".pytest_cache/a": "x",
  ".ruff_cache/a": "x",
  ".venv/bin/python": "x",
  ".sisyphus/a": "x",
  ".claude/settings.json": "x",
  ".in_use/lock": "x",
  "benchmarks/perf/r.json": "x",
  "docs/design/d.md": "x",
  "docs/CLAUDE.md": "x",
  "tests/t.spec.ts": "x",
  "servers/tests/y.py": "x",
  "scripts/qa/lib.ts": "x",
  "servers/m.pyc": "x",
  "servers/__pycache__/m.py": "x",
  "node_modules/m/index.js": "x",
  "CLAUDE.md": "x",
  "TODO.md": "x",
  "UPGRADE.md": "x",
};

let root = "";
let dest = "";

function seed(base: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), text);
  }
}

const filesUnder = (base: string): string[] => [...new Bun.Glob("**/*").scanSync({ cwd: base, dot: true, onlyFiles: true })].sort();

beforeEach(() => {
  const scratch = mkdtempSync(join(tmpdir(), "omca-package-spec-"));
  root = join(scratch, "root");
  dest = join(scratch, "dest");
  seed(root, { ...SHIPPED, ...EXCLUDED });
});

afterEach(() => {
  rmSync(dirname(root), { recursive: true, force: true });
});

describe("listPackageFiles", () => {
  test("lists exactly the shipped files, sorted, and drops every excluded name at any depth", () => {
    expect(listPackageFiles(root)).toEqual(Object.keys(SHIPPED).sort());
  });
});

describe("packageTree", () => {
  test("copies the listed files with their contents and nothing else", () => {
    const files = packageTree(root, dest);

    expect(files).toEqual(Object.keys(SHIPPED).sort());
    expect(filesUnder(dest)).toEqual(files);
    for (const [path, text] of Object.entries(SHIPPED)) expect(readFileSync(join(dest, path), "utf8")).toBe(text);
  });

  test.skipIf(process.platform === "win32")("keeps the executable bit", () => {
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
      ".venv/keep": "x",
      "docs/stale.md": "x",
    });

    packageTree(root, dest);

    expect(filesUnder(dest)).toEqual([...Object.keys(SHIPPED), ".venv/keep"].sort());
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

  test("--version overrides the manifest version", () => {
    expect(main([dest, "--version", "1.2.3"], root).stdout).toBe(`packaging v1.2.3 → ${dest}\n`);
  });

  test("reports an unknown version when the manifest is unreadable", () => {
    rmSync(join(root, ".claude-plugin", "plugin.json"));

    expect(main([dest], root).stdout).toBe(`packaging vunknown → ${dest}\n`);
  });

  test.each([
    [[], "Missing <dest_dir>"],
    [["--bogus", dest], "Unknown option '--bogus'"],
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
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "package.ts"), "--dry-run"], { stdout: "pipe", stderr: "pipe" });
    const lines = result.stdout.toString().split("\n");

    expect(result.exitCode).toBe(0);
    expect(lines).toContain("templates/claudemd.md");
    expect(lines).toContain("scripts/package.ts");
    expect(lines.filter((line) => /^scripts\/qa\/|(^|\/)tests\//.test(line))).toEqual([]);
  });
});
