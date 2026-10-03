import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { specEnv } from "../tests/fixtures/spec-env.ts";
import { main, PLUGIN_URL, release } from "./release.ts";

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

const PACKAGED = [".claude-plugin/marketplace.json", ".claude-plugin/plugin.json", "CHANGELOG.md", "README.md", "agents/a.md"];

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
  write("bun.lock", "lock\n");
  write("tsconfig.json", "{}\n");
  write("README.md", "readme\n");
  write("agents/a.md", "agent\n");
  write("tests/t.spec.ts", "x\n");
  write("CHANGELOG.md", CHANGELOG);
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("release", () => {
  test("bumps every version field, tags the bump, packages it and stamps the packaged commit", () => {
    const initial = git("rev-parse", "HEAD");
    const { bump, plugin, stamp } = release(root, "3.0.0-rc.1");

    expect(json(".claude-plugin/plugin.json").version).toBe("3.0.0-rc.1");
    expect(json("package.json").version).toBe("3.0.0-rc.1");
    const marketplace = json(".claude-plugin/marketplace.json");
    expect(marketplace.metadata.version).toBe("3.0.0-rc.1");
    expect(marketplace.plugins[0].version).toBe("3.0.0-rc.1");
    expect(marketplace.plugins[0].source).toEqual({ source: "url", url: PLUGIN_URL, ref: "plugin", sha: plugin });

    expect(git("rev-parse", "HEAD")).toBe(stamp);
    expect(git("rev-parse", "HEAD~1")).toBe(bump);
    expect(git("rev-parse", "HEAD~2")).toBe(initial);
    expect(git("rev-parse", "v3.0.0-rc.1^{commit}")).toBe(bump);
    expect(git("rev-parse", "plugin-v3.0.0-rc.1^{commit}")).toBe(plugin);
    expect(git("rev-parse", "plugin")).toBe(plugin);
    expect(git("log", "--format=%s", "-2")).toBe("chore(release): stamp v3.0.0-rc.1 plugin SHA\nchore(release): bump version to 3.0.0-rc.1");
    expect(git("show", `${bump}:.claude-plugin/marketplace.json`)).toContain(`"sha": "${"0".repeat(40)}"`);
  });

  test("the first run creates the plugin branch as an orphan holding only the tracked shipped files", () => {
    write("untracked.txt", "x\n");
    const { plugin } = release(root, "3.0.0-rc.1");

    expect(git("rev-list", "--parents", "-n", "1", "plugin")).toBe(plugin);
    expect(git("rev-list", "--count", "plugin")).toBe("1");
    expect(git("log", "--format=%s", "-1", "plugin")).toBe("chore(release): package v3.0.0-rc.1");
    expect(git("ls-tree", "-r", "--name-only", "plugin").split("\n")).toEqual(PACKAGED);
    expect(JSON.parse(git("show", "plugin:.claude-plugin/plugin.json")).version).toBe("3.0.0-rc.1");
  });

  test("the second run adds a commit on top of the branch and a tag for its version", () => {
    const first = release(root, "3.0.0-rc.1").plugin;
    write("CHANGELOG.md", `${CHANGELOG}\n## [3.0.0-rc.2] - 2026-10-04\n`);
    git("commit", "-q", "-am", "changelog");
    const second = release(root, "3.0.0-rc.2").plugin;

    expect(git("rev-list", "--parents", "-n", "1", "plugin")).toBe(`${second} ${first}`);
    expect(git("rev-list", "--count", "plugin")).toBe("2");
    expect(git("tag", "--list").split("\n")).toEqual(["plugin-v3.0.0-rc.1", "plugin-v3.0.0-rc.2", "v3.0.0-rc.1", "v3.0.0-rc.2"]);
    expect(git("rev-parse", "plugin-v3.0.0-rc.2^{commit}")).toBe(second);
    expect(json(".claude-plugin/marketplace.json").plugins[0].source.sha).toBe(second);
    expect(JSON.parse(git("show", "plugin:.claude-plugin/plugin.json")).version).toBe("3.0.0-rc.2");
  });

  test("the packaged tree has no package.json or bun.lock, and the main tree keeps them", () => {
    release(root, "3.0.0-rc.1");
    const packaged = git("ls-tree", "-r", "--name-only", "plugin").split("\n");

    expect(packaged).not.toContain("package.json");
    expect(packaged).not.toContain("bun.lock");
    expect(packaged).not.toContain("tsconfig.json");
    expect(packaged).not.toContain("tests/t.spec.ts");
    expect(git("ls-tree", "-r", "--name-only", "HEAD")).toContain("package.json");
    expect(git("ls-tree", "-r", "--name-only", "HEAD")).toContain("bun.lock");
  });

  test("leaves no worktree behind and does not check out the plugin branch", () => {
    release(root, "3.0.0-rc.1");

    expect(git("worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1);
    expect(git("branch", "--show-current")).not.toBe("plugin");
  });

  test("changes only the version lines and the source", () => {
    release(root, "3.0.0-rc.1");
    const changed = git("diff", "HEAD~2", "--numstat", "--", ".claude-plugin", "package.json").split("\n").sort();
    expect(changed).toEqual([
      "1\t1\t.claude-plugin/plugin.json",
      "1\t1\tpackage.json",
      "6\t4\t.claude-plugin/marketplace.json",
    ]);
  });
});

describe("a failed release", () => {
  const hook = (script: string) => {
    write(".git/hooks/pre-commit", `#!/bin/sh\n${script}\n`)
    chmodSync(join(root, ".git/hooks/pre-commit"), 0o755)
  }
  const commitMsgHook = (script: string) => {
    write(".git/hooks/commit-msg", `#!/bin/sh\n${script}\n`)
    chmodSync(join(root, ".git/hooks/commit-msg"), 0o755)
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
    expect(git("branch", "--list", "plugin")).toBe("")
    expect(manifests()).toEqual(before)
    hook("exit 0")
    expect(main(["3.0.0-rc.1"], root).code).toBe(0)
  })

  test("a failure on the stamp commit removes the tags and the plugin branch this run created", () => {
    commitMsgHook("grep -q stamp \"$1\" && exit 1\nexit 0")
    const head = git("rev-parse", "HEAD")
    const { code, stderr } = main(["3.0.0-rc.1"], root)
    expect(code).toBe(1)
    expect(stderr).toContain(`restored the tree to ${head}`)
    expect(git("status", "--porcelain")).toBe("")
    expect(git("rev-parse", "HEAD")).toBe(head)
    expect(git("tag", "--list")).toBe("")
    expect(git("branch", "--list", "plugin")).toBe("")
    expect(git("worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1)
  })

  test("a failure on the second release puts the plugin branch back on its first commit and keeps the first tags", () => {
    const first = release(root, "3.0.0-rc.1").plugin
    write("CHANGELOG.md", `${CHANGELOG}\n## [3.0.0-rc.2] - 2026-10-04\n`)
    git("commit", "-q", "-am", "changelog")
    const head = git("rev-parse", "HEAD")
    commitMsgHook("grep -q stamp \"$1\" && exit 1\nexit 0")
    const { code, stderr } = main(["3.0.0-rc.2"], root)
    expect(code).toBe(1)
    expect(stderr).toContain(`restored the tree to ${head}`)
    expect(git("rev-parse", "HEAD")).toBe(head)
    expect(git("rev-parse", "plugin")).toBe(first)
    expect(git("tag", "--list").split("\n")).toEqual(["plugin-v3.0.0-rc.1", "v3.0.0-rc.1"])
  })
})

describe("main", () => {
  test("a release prints how to push and has no remote to push to", () => {
    const { code, stdout, stderr } = main(["3.0.0-rc.1"], root);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain("  git push origin plugin plugin-v3.0.0-rc.1\n  git push origin HEAD v3.0.0-rc.1\n");
    expect(stdout.indexOf("git push origin plugin")).toBeLessThan(stdout.indexOf("git push origin HEAD"));
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
    expect(git("tag", "--list")).toBe("plugin-v3.0.0+build.5\nv3.0.0+build.5");
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

  test("refuses a packaged-commit tag that already exists", () => {
    git("tag", "plugin-v3.0.0-rc.1");
    const { code, stderr } = main(["3.0.0-rc.1"], root);
    expect(code).toBe(1);
    expect(stderr).toContain("tag plugin-v3.0.0-rc.1 already exists");
    expect(git("branch", "--list", "plugin")).toBe("");
  });

  test("tags the packaged commit outside the release workflow's v*.*.* filter", () => {
    release(root, "3.0.0-rc.1");
    const filter = /^v.*\..*\..*$/;
    expect(git("tag", "--list").split("\n").filter((tag) => filter.test(tag))).toEqual(["v3.0.0-rc.1"]);
  });

  test("needs exactly one version", () => {
    expect(main([], root).stderr).toContain("Missing <version>");
    expect(main(["3.0.0-rc.1", "extra"], root).stderr).toContain("Unexpected argument: extra");
  });
});
