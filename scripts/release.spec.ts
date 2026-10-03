import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
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

// Each test and its setup drive a dozen git processes, and one can take seconds on a Windows runner.
const GIT_HEAVY_MS = 60_000;
setDefaultTimeout(GIT_HEAVY_MS);

let scratch = "";
let root = "";
let origin = "";

function gitIn(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(["git", ...args], { cwd, env: specEnv(), stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

const git = (...args: string[]): string => gitIn(root, ...args);

function configure(cwd: string): void {
  gitIn(cwd, "config", "user.name", "Spec");
  gitIn(cwd, "config", "user.email", "spec@example.com");
  gitIn(cwd, "config", "commit.gpgsign", "false");
  gitIn(cwd, "config", "core.autocrlf", "false");
}

const publish = (): string => git("push", "-q", "origin", "main");

function addChangelog(version: string): void {
  write("CHANGELOG.md", `${readFileSync(join(root, "CHANGELOG.md"), "utf8")}\n## [${version}] - 2026-10-04\n`);
  git("commit", "-q", "-am", "changelog");
  publish();
}

function write(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

const json = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));

const PACKAGED = [".claude-plugin/marketplace.json", ".claude-plugin/plugin.json", "CHANGELOG.md", "README.md", "agents/a.md"];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "omca-release-spec-"));
  root = join(scratch, "repo");
  origin = join(scratch, "origin.git");
  mkdirSync(root);
  git("init", "-q", "-b", "main");
  configure(root);
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
  gitIn(scratch, "init", "-q", "--bare", "-b", "main", origin);
  git("remote", "add", "origin", origin);
  publish();
}, GIT_HEAVY_MS);

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}, GIT_HEAVY_MS);

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
  const hook = (name: string, script: string) => {
    write(`.git/hooks/${name}`, `#!/bin/sh\n${script}\n`);
    chmodSync(join(root, ".git/hooks", name), 0o755);
  };
  const manifests = () => [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", "package.json"].map((path) => readFileSync(join(root, path), "utf8"));

  test("a pre-commit hook that rejects the bump leaves the tree, HEAD and tags as they were", () => {
    hook("pre-commit", "exit 1");
    const head = git("rev-parse", "HEAD");
    const before = manifests();
    const { code, stderr } = main(["3.0.0-rc.1"], root);
    expect(code).toBe(1);
    expect(stderr).toContain(`restored the tree to ${head}`);
    expect(git("status", "--porcelain")).toBe("");
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("tag", "--list")).toBe("");
    expect(git("branch", "--list", "plugin")).toBe("");
    expect(manifests()).toEqual(before);
    hook("pre-commit", "exit 0");
    expect(main(["3.0.0-rc.1"], root).code).toBe(0);
  });

  test("a failure on the stamp commit removes the tags and the plugin branch this run created", () => {
    hook("commit-msg", 'grep -q stamp "$1" && exit 1\nexit 0');
    const head = git("rev-parse", "HEAD");
    const { code, stderr } = main(["3.0.0-rc.1"], root);
    expect(code).toBe(1);
    expect(stderr).toContain(`restored the tree to ${head}`);
    expect(git("status", "--porcelain")).toBe("");
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("tag", "--list")).toBe("");
    expect(git("branch", "--list", "plugin")).toBe("");
    expect(git("worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1);
  });

  test("a failure on the second release puts the plugin branch back on its first commit and keeps the first tags", () => {
    const first = release(root, "3.0.0-rc.1").plugin;
    addChangelog("3.0.0-rc.2");
    const head = git("rev-parse", "HEAD");
    hook("commit-msg", 'grep -q stamp "$1" && exit 1\nexit 0');
    const { code, stderr } = main(["3.0.0-rc.2"], root);
    expect(code).toBe(1);
    expect(stderr).toContain(`restored the tree to ${head}`);
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("rev-parse", "plugin")).toBe(first);
    expect(git("tag", "--list").split("\n")).toEqual(["plugin-v3.0.0-rc.1", "v3.0.0-rc.1"]);
  });
});

describe("the remote", () => {
  const PUSH = "git push --atomic origin main plugin v3.0.0-rc.1 plugin-v3.0.0-rc.1";

  test("the printed push publishes both branches and both tags, and a fresh clone builds the next package on the published branch", () => {
    const { code, stdout } = main(["3.0.0-rc.1"], root);
    expect(code).toBe(0);
    expect(stdout).toContain(`  ${PUSH}\n`);
    git(...PUSH.split(" ").slice(1));
    const first = git("rev-parse", "plugin");
    expect(gitIn(origin, "rev-parse", "plugin")).toBe(first);
    expect(gitIn(origin, "rev-parse", "main")).toBe(git("rev-parse", "HEAD"));

    const clone = join(scratch, "clone");
    gitIn(scratch, "clone", "-q", origin, clone);
    configure(clone);
    expect(gitIn(clone, "branch", "--list", "plugin")).toBe("");
    const previous = root;
    root = clone;
    try {
      addChangelog("3.0.0-rc.2");
      const { code: second, stderr } = main(["3.0.0-rc.2"], clone);
      expect(stderr).toBe("");
      expect(second).toBe(0);
      expect(gitIn(clone, "rev-parse", "plugin^")).toBe(first);
      expect(gitIn(clone, "rev-list", "--count", "plugin")).toBe("2");
    } finally {
      root = previous;
    }
  });

  test("refuses when the local plugin branch is behind origin/plugin", () => {
    main(["3.0.0-rc.1"], root);
    git(...PUSH.split(" ").slice(1));
    const stale = git("rev-parse", "plugin");
    const newer = git("commit-tree", "plugin^{tree}", "-p", "plugin", "-m", "published elsewhere");
    git("push", "-q", "origin", `${newer}:refs/heads/plugin`);
    addChangelog("3.0.0-rc.2");
    expect(git("rev-parse", "origin/plugin")).toBe(newer);

    const { code, stderr } = main(["3.0.0-rc.2"], root);

    expect(code).toBe(1);
    expect(stderr).toBe("ERROR: the local plugin branch does not contain origin/plugin; run git branch -f plugin origin/plugin\n");
    expect(git("rev-parse", "plugin")).toBe(stale);
  });

  test.each([
    ["off main", () => git("checkout", "-q", "-b", "topic"), "ERROR: releases are cut from main; check it out first\n"],
    ["ahead of origin/main", () => git("commit", "-q", "--allow-empty", "-m", "local"), "ERROR: main is not even with origin/main; fetch, then pull or push until they match\n"],
    ["behind origin/main", () => {
      git("commit", "-q", "--allow-empty", "-m", "pushed");
      publish();
      git("reset", "-q", "--hard", "HEAD~1");
    }, "ERROR: main is not even with origin/main; fetch, then pull or push until they match\n"],
    ["with no origin", () => git("remote", "remove", "origin"), "ERROR: main is not even with origin/main; fetch, then pull or push until they match\n"],
  ])("refuses a checkout %s and changes nothing", (_, arrange, refusal) => {
    arrange();
    const head = git("rev-parse", "HEAD");

    expect(main(["3.0.0-rc.1"], root)).toEqual({ code: 1, stdout: "", stderr: refusal });
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("tag", "--list")).toBe("");
    expect(git("branch", "--list", "plugin")).toBe("");
  });
});

describe("main", () => {
  test("a release prints one atomic push and pushes nothing itself", () => {
    const before = gitIn(origin, "for-each-ref");
    const { code, stdout, stderr } = main(["3.0.0-rc.1"], root);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain("\n  git push --atomic origin main plugin v3.0.0-rc.1 plugin-v3.0.0-rc.1\n");
    expect(gitIn(origin, "for-each-ref")).toBe(before);
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
    addChangelog("3.0.0+build.5");
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
