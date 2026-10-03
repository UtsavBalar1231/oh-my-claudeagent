import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { specEnv } from "../tests/fixtures/spec-env.ts";
import { main, release } from "./release.ts";

const PLUGIN = '{\n  "name": "demo",\n  "version": "1.0.0"\n}\n';
const MARKETPLACE = `${JSON.stringify(
  { name: "demo", metadata: { version: "1.0.0" }, plugins: [{ name: "demo", version: "1.0.0", source: { source: "github", sha: "0".repeat(40) } }] },
  null,
  2,
)}\n`;
const PACKAGE = '{\n  "name": "demo",\n  "version": "1.0.0"\n}\n';
const CHANGELOG = "# Changelog\n\n## [Unreleased]\n\n## [3.0.0-rc.1] - 2026-10-03\n\n- Added a thing.\n";

let root = "";

function git(...args: string[]): string {
  const run = Bun.spawnSync(["git", ...args], { cwd: root, env: specEnv(), stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

function write(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

const json = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omca-release-spec-"));
  git("init", "-q");
  git("config", "user.name", "Spec");
  git("config", "user.email", "spec@example.com");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  write(".claude-plugin/plugin.json", PLUGIN);
  write(".claude-plugin/marketplace.json", MARKETPLACE);
  write("package.json", PACKAGE);
  write("CHANGELOG.md", CHANGELOG);
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("release", () => {
  test("bumps every version field, stamps the bump commit and tags it", () => {
    const initial = git("rev-parse", "HEAD");
    const { bump, stamp } = release(root, "3.0.0-rc.1");

    expect(json(".claude-plugin/plugin.json").version).toBe("3.0.0-rc.1");
    expect(json("package.json").version).toBe("3.0.0-rc.1");
    const marketplace = json(".claude-plugin/marketplace.json");
    expect(marketplace.metadata.version).toBe("3.0.0-rc.1");
    expect(marketplace.plugins[0].version).toBe("3.0.0-rc.1");
    expect(marketplace.plugins[0].source.sha).toBe(bump);

    expect(git("rev-parse", "HEAD")).toBe(stamp);
    expect(git("rev-parse", "HEAD~1")).toBe(bump);
    expect(git("rev-parse", "HEAD~2")).toBe(initial);
    expect(git("rev-parse", "v3.0.0-rc.1^{commit}")).toBe(bump);
    expect(git("log", "--format=%s", "-2")).toBe("chore(release): stamp v3.0.0-rc.1 SHA\nchore(release): bump version to 3.0.0-rc.1");
    expect(git("show", `${bump}:.claude-plugin/marketplace.json`)).toContain(`"sha": "${"0".repeat(40)}"`);
  });

  test("changes only the version lines and the SHA", () => {
    release(root, "3.0.0-rc.1");
    const changed = git("diff", "HEAD~2", "--numstat", "--", ".claude-plugin", "package.json").split("\n").sort();
    expect(changed).toEqual([
      "1\t1\t.claude-plugin/plugin.json",
      "1\t1\tpackage.json",
      "3\t3\t.claude-plugin/marketplace.json",
    ]);
  });
});

describe("a failed release", () => {
  const hook = (script: string) => {
    write(".git/hooks/pre-commit", `#!/bin/sh\n${script}\n`)
    chmodSync(join(root, ".git/hooks/pre-commit"), 0o755)
  }
  const manifests = () => [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", "package.json"].map((path) => readFileSync(join(root, path), "utf8"))

  test("a pre-commit hook that rejects the bump leaves the tree, HEAD and tags as they were", () => {
    hook("exit 1")
    const head = git("rev-parse", "HEAD")
    const before = manifests()
    const { code, stderr } = main(["3.0.0-rc.1"], root)
    expect(code).toBe(1)
    expect(stderr).toContain(`restored the tree to ${head}`)
    expect(git("status", "--porcelain")).toBe("")
    expect(git("rev-parse", "HEAD")).toBe(head)
    expect(git("tag", "--list")).toBe("")
    expect(manifests()).toEqual(before)
    hook("exit 0")
    expect(main(["3.0.0-rc.1"], root).code).toBe(0)
  })

  test("a failure after the bump commit rewinds to the starting commit and keeps no tag", () => {
    hook('[ "$(git rev-list --count HEAD)" -gt 1 ] && exit 1\nexit 0')
    const head = git("rev-parse", "HEAD")
    const { code, stderr } = main(["3.0.0-rc.1"], root)
    expect(code).toBe(1)
    expect(stderr).toContain(`restored the tree to ${head}`)
    expect(git("status", "--porcelain")).toBe("")
    expect(git("rev-parse", "HEAD")).toBe(head)
    expect(git("tag", "--list")).toBe("")
  })
})

describe("main", () => {
  test("a release prints how to push and has no remote to push to", () => {
    const { code, stdout, stderr } = main(["3.0.0-rc.1"], root);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain("git push origin HEAD v3.0.0-rc.1");
    expect(git("remote")).toBe("");
  });

  test("refuses a tree with an uncommitted change and leaves it as it was", () => {
    write("package.json", `${PACKAGE} `);
    const head = git("rev-parse", "HEAD");
    const { code, stderr } = main(["3.0.0-rc.1"], root);
    expect(code).toBe(1);
    expect(stderr).toContain("uncommitted changes");
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("tag", "--list")).toBe("");
  });

  test("ignores an untracked file", () => {
    write("scratch.txt", "x");
    expect(main(["3.0.0-rc.1"], root).code).toBe(0);
  });

  test("refuses a version with no changelog entry", () => {
    const { code, stderr } = main(["3.0.0"], root);
    expect(code).toBe(1);
    expect(stderr).toContain("CHANGELOG.md has no ## [3.0.0] entry");
    expect(json("package.json").version).toBe("1.0.0");
  });

  test("accepts a version with build metadata, as the manifest check does", () => {
    write("CHANGELOG.md", `${CHANGELOG}\n## [3.0.0+build.5] - 2026-10-04\n`);
    git("commit", "-q", "-am", "changelog");
    const { code, stderr } = main(["3.0.0+build.5"], root);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(git("tag", "--list")).toBe("v3.0.0+build.5");
  });

  test("refuses a version that is not semver", () => {
    for (const version of ["3", "v3.0.0", "3.0.0 -x", "3.0.0-", "3.0.0+"]) {
      expect(main([version], root).stderr).toContain("is not a version");
    }
  });

  test("refuses a tag that already exists", () => {
    git("tag", "v3.0.0-rc.1");
    const { code, stderr } = main(["3.0.0-rc.1"], root);
    expect(code).toBe(1);
    expect(stderr).toContain("tag v3.0.0-rc.1 already exists");
  });

  test("needs exactly one version", () => {
    expect(main([], root).stderr).toContain("Missing <version>");
    expect(main(["3.0.0-rc.1", "extra"], root).stderr).toContain("Unexpected argument: extra");
  });
});
