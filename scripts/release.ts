#!/usr/bin/env bun
// Cuts a release locally and never pushes: bumps the version in the manifests, commits it, stamps
// that commit's SHA into marketplace.json in a child commit (a commit cannot contain its own SHA,
// and installs fetch the plugin tree at the stamped SHA), and tags the bump commit.
//
// Usage: bun scripts/release.ts <version>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const USAGE = "Usage: bun scripts/release.ts <version>";
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const PLUGIN = ".claude-plugin/plugin.json";
const MARKETPLACE = ".claude-plugin/marketplace.json";
const PACKAGE = "package.json";

type Versioned = { version: string };
type Marketplace = { metadata: Versioned; plugins: Array<Versioned & { source: { sha?: string } }> };
export type Outcome = { code: number; stdout: string; stderr: string };

function git(root: string, args: string[]): string {
  const run = Bun.spawnSync(["git", ...args], { cwd: root, env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
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
  if (!VERSION.test(version)) return `"${version}" is not a version such as 3.0.0 or 3.0.0-rc.1`;
  if (git(root, ["status", "--porcelain", "--untracked-files=no"]) !== "") {
    return "the working tree has uncommitted changes; commit or stash them first";
  }
  const heading = `## [${version}]`;
  if (!readFileSync(join(root, "CHANGELOG.md"), "utf8").split(/\r?\n/).some((line) => line.startsWith(heading))) {
    return `CHANGELOG.md has no ${heading} entry; add one first`;
  }
  if (git(root, ["tag", "--list", `v${version}`]) !== "") return `tag v${version} already exists`;
  return undefined;
}

export function release(root: string, version: string): { bump: string; stamp: string } {
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
  git(root, ["add", PLUGIN, MARKETPLACE, PACKAGE]);
  git(root, ["commit", "-m", `chore(release): bump version to ${version}`]);
  const bump = git(root, ["rev-parse", "HEAD"]);

  edit<Marketplace>(root, MARKETPLACE, (json) => {
    json.plugins[0].source.sha = bump;
  });
  git(root, ["add", MARKETPLACE]);
  git(root, ["commit", "-m", `chore(release): stamp v${version} SHA`]);
  const stamp = git(root, ["rev-parse", "HEAD"]);

  git(root, ["tag", `v${version}`, bump]);
  return { bump, stamp };
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
    const { bump, stamp } = release(root, version);
    const stdout = [
      `Bumped to ${version} at ${bump.slice(0, 7)}`,
      `Stamped ${bump} in ${MARKETPLACE} at ${stamp.slice(0, 7)}`,
      `Tagged v${version} at ${bump.slice(0, 7)}`,
      "",
      `Release ${version} is ready. Push it with:`,
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
