#!/usr/bin/env bun
// Cuts a release locally and never pushes: bumps the version in the manifests, commits it and tags
// the bump commit, packages the tag's tracked files (no package.json or bun.lock, so an install
// fetches no npm packages) as a commit on the orphan `plugin` branch, then stamps that packaged
// commit's SHA into marketplace.json in a child commit of the bump (a commit cannot contain its own
// SHA, and installs fetch the plugin tree at the stamped SHA). The packaged commit's tag is
// `plugin-v<version>`: release.yml runs on `v*.*.*`, whose `*` also matches dots and dashes, so a
// `v<version>-plugin` tag would start a release run on a tree with no package.json.
//
// Usage: bun scripts/release.ts <version>
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageTree } from "./package.ts";

const USAGE = "Usage: bun scripts/release.ts <version>";
export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const PLUGIN = ".claude-plugin/plugin.json";
const MARKETPLACE = ".claude-plugin/marketplace.json";
const PACKAGE = "package.json";
const MANIFESTS = [PLUGIN, MARKETPLACE, PACKAGE];
export const PLUGIN_BRANCH = "plugin";
export const PLUGIN_URL = "https://github.com/UtsavBalar1231/oh-my-claudeagent.git";

type Versioned = { version: string };
type MarketplacePlugin = Versioned & { source: Record<string, string> };
type Marketplace = { metadata: Versioned; plugins: [MarketplacePlugin, ...MarketplacePlugin[]] };
export type Outcome = { code: number; stdout: string; stderr: string };

function git(root: string, args: string[], env: Record<string, string> = {}): string {
  const run = Bun.spawnSync(["git", ...args], { cwd: root, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${run.stdout.toString()}${run.stderr.toString()}`.trimEnd());
  }
  return run.stdout.toString().trim();
}

function edit<T>(root: string, path: string, change: (json: T) => void): void {
  const file = join(root, path);
  const json = JSON.parse(readFileSync(file, "utf8")) as T;
  change(json);
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}

function refuse(root: string, version: string): string | undefined {
  if (!SEMVER.test(version)) return `"${version}" is not a version such as 3.0.0 or 3.0.0-rc.1`;
  if (git(root, ["status", "--porcelain", "--untracked-files=no"]) !== "") {
    return "the working tree has uncommitted changes; commit or stash them first";
  }
  const heading = `## [${version}]`;
  if (!readFileSync(join(root, "CHANGELOG.md"), "utf8").split(/\r?\n/).some((line) => line.startsWith(heading))) {
    return `CHANGELOG.md has no ${heading} entry; add one first`;
  }
  for (const tag of [`v${version}`, `plugin-v${version}`]) {
    if (git(root, ["tag", "--list", tag]) !== "") return `tag ${tag} already exists`;
  }
  return undefined;
}

const pluginTip = (root: string): string => git(root, ["for-each-ref", "--format=%(objectname)", `refs/heads/${PLUGIN_BRANCH}`]);

function commitPackaged(root: string, version: string, tag: string): string {
  const scratch = mkdtempSync(join(tmpdir(), "omca-release-"));
  const checkout = join(scratch, "checkout");
  const packaged = join(scratch, "packaged");
  try {
    git(root, ["worktree", "add", "--detach", checkout, tag]);
    try {
      packageTree(checkout, packaged);
    } finally {
      git(root, ["worktree", "remove", "--force", checkout]);
    }
    const env = { GIT_DIR: git(root, ["rev-parse", "--absolute-git-dir"]), GIT_WORK_TREE: packaged, GIT_INDEX_FILE: join(scratch, "index") };
    git(packaged, ["add", "--force", "--all"], env);
    const parent = pluginTip(root);
    const commit = git(packaged, ["commit-tree", git(packaged, ["write-tree"], env), ...(parent === "" ? [] : ["-p", parent]), "-m", `chore(release): package v${version}`], env);
    git(root, ["update-ref", `refs/heads/${PLUGIN_BRANCH}`, commit]);
    return commit;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function release(root: string, version: string): { bump: string; plugin: string; stamp: string } {
  const start = git(root, ["rev-parse", "HEAD"]);
  const previousPlugin = pluginTip(root);
  const tag = `v${version}`;
  const pluginTag = `plugin-${tag}`;
  try {
    edit<Versioned>(root, PLUGIN, (json) => {
      json.version = version;
    });
    edit<Marketplace>(root, MARKETPLACE, (json) => {
      json.metadata.version = version;
      json.plugins[0].version = version;
    });
    edit<Versioned>(root, PACKAGE, (json) => {
      json.version = version;
    });
    git(root, ["add", ...MANIFESTS]);
    git(root, ["commit", "-m", `chore(release): bump version to ${version}`]);
    const bump = git(root, ["rev-parse", "HEAD"]);
    git(root, ["tag", tag, bump]);

    const plugin = commitPackaged(root, version, tag);
    git(root, ["tag", pluginTag, plugin]);

    edit<Marketplace>(root, MARKETPLACE, (json) => {
      json.plugins[0].source = { source: "url", url: PLUGIN_URL, ref: PLUGIN_BRANCH, sha: plugin };
    });
    git(root, ["add", MARKETPLACE]);
    git(root, ["commit", "-m", `chore(release): stamp v${version} plugin SHA`]);
    const stamp = git(root, ["rev-parse", "HEAD"]);
    return { bump, plugin, stamp };
  } catch (error) {
    // The manifests were clean when the run began, so restoring only them loses nothing the run did not write.
    git(root, ["restore", `--source=${start}`, "--staged", "--worktree", "--", ...MANIFESTS]);
    git(root, ["reset", "--keep", start]);
    for (const name of [tag, pluginTag]) {
      if (git(root, ["tag", "--list", name]) !== "") git(root, ["tag", "-d", name]);
    }
    if (previousPlugin === "") git(root, ["update-ref", "-d", `refs/heads/${PLUGIN_BRANCH}`]);
    else git(root, ["update-ref", `refs/heads/${PLUGIN_BRANCH}`, previousPlugin]);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nrestored the tree to ${start}`);
  }
}

export function main(args: string[], root: string): Outcome {
  const [version, ...extra] = args;
  if (version === undefined || extra.length > 0) {
    const problem = version === undefined ? "Missing <version>" : `Unexpected argument: ${extra[0]}`;
    return { code: 1, stdout: "", stderr: `${problem}\n${USAGE}\n` };
  }
  try {
    const refusal = refuse(root, version);
    if (refusal !== undefined) return { code: 1, stdout: "", stderr: `ERROR: ${refusal}\n` };
    const { bump, plugin, stamp } = release(root, version);
    const stdout = [
      `Bumped to ${version} at ${bump.slice(0, 7)}`,
      `Packaged v${version} as ${plugin.slice(0, 7)} on the ${PLUGIN_BRANCH} branch`,
      `Stamped ${plugin} in ${MARKETPLACE} at ${stamp.slice(0, 7)}`,
      `Tagged v${version} at ${bump.slice(0, 7)} and plugin-v${version} at ${plugin.slice(0, 7)}`,
      "",
      `Release ${version} is ready. Push the ${PLUGIN_BRANCH} branch first: the stamped SHA must exist on the remote before the main commits that name it.`,
      `  git push origin ${PLUGIN_BRANCH} plugin-v${version}`,
      `  git push origin HEAD v${version}`,
      "",
    ].join("\n");
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return { code: 1, stdout: "", stderr: `ERROR: ${error instanceof Error ? error.message : String(error)}\n` };
  }
}

if (import.meta.main) {
  const { code, stdout, stderr } = main(Bun.argv.slice(2), join(import.meta.dir, ".."));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
