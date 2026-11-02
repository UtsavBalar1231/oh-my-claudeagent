import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workingTreeStamp } from "./tree-stamp.ts";

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const scratchDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "omca-stamp-spec-"));
  made.push(dir);
  return dir;
};

function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(["git", "-c", "user.email=spec@example.invalid", "-c", "user.name=spec", "-c", "core.autocrlf=false", ...args], { cwd });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

function repo(): string {
  const dir = scratchDir();
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".gitignore"), "ignored.log\n");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

const objectFiles = (dir: string): string[] =>
  readdirSync(join(dir, ".git", "objects"), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));

describe("workingTreeStamp", () => {
  test("a clean checkout stamps as the commit's tree", async () => {
    const dir = repo();
    expect(await workingTreeStamp(dir)).toBe(git(dir, "rev-parse", "HEAD^{tree}"));
  });

  test("an uncommitted edit changes the stamp, and reverting it restores the stamp", async () => {
    const dir = repo();
    const clean = await workingTreeStamp(dir);
    writeFileSync(join(dir, "a.txt"), "two\n");
    expect(await workingTreeStamp(dir)).not.toBe(clean);
    writeFileSync(join(dir, "a.txt"), "one\n");
    expect(await workingTreeStamp(dir)).toBe(clean);
  });

  test("an untracked file changes the stamp", async () => {
    const dir = repo();
    const clean = await workingTreeStamp(dir);
    writeFileSync(join(dir, "b.txt"), "new\n");
    expect(await workingTreeStamp(dir)).not.toBe(clean);
  });

  test("an ignored file leaves the stamp alone", async () => {
    const dir = repo();
    const clean = await workingTreeStamp(dir);
    writeFileSync(join(dir, "ignored.log"), "noise\n");
    expect(await workingTreeStamp(dir)).toBe(clean);
  });

  test("stamping leaves the real index and object store untouched", async () => {
    const dir = repo();
    writeFileSync(join(dir, "b.txt"), "new\n");
    const index = readFileSync(join(dir, ".git", "index"));
    const objects = objectFiles(dir);
    await workingTreeStamp(dir);
    expect(readFileSync(join(dir, ".git", "index")).equals(index)).toBe(true);
    expect(objectFiles(dir)).toEqual(objects);
  });

  test("a linked worktree stamps its own files", async () => {
    const dir = repo();
    const linked = join(scratchDir(), "linked");
    git(dir, "worktree", "add", "-q", linked, "-b", "side");
    const clean = await workingTreeStamp(linked);
    expect(clean).toBe(git(dir, "rev-parse", "HEAD^{tree}"));
    writeFileSync(join(linked, "c.txt"), "side\n");
    expect(await workingTreeStamp(linked)).not.toBe(clean);
    expect(await workingTreeStamp(dir)).toBe(clean);
  });

  test("a subdirectory stamps the whole repository", async () => {
    const dir = repo();
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "d.txt"), "deep\n");
    expect(await workingTreeStamp(join(dir, "sub"))).toBe(await workingTreeStamp(dir));
  });

  test("a Claude Code worktree under an unignored .claude leaves the stamp alone", async () => {
    const dir = repo();
    const clean = await workingTreeStamp(dir);
    git(dir, "worktree", "add", "-q", join(dir, ".claude", "worktrees", "agent-a"), "-b", "agent-a");
    expect(await workingTreeStamp(dir)).toBe(clean);
  });

  test("a repository with no commits and no files stamps as the empty tree", async () => {
    const dir = scratchDir();
    git(dir, "init", "-q");
    expect(await workingTreeStamp(dir)).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });

  test("a directory outside any repository has no stamp", async () => {
    expect(await workingTreeStamp(scratchDir())).toBeNull();
  });

  describe("when the environment cannot make a stamp", () => {
    const saved = { ...process.env };
    afterEach(() => {
      for (const name of ["PATH", "Path", "TMPDIR", "TEMP", "TMP"]) {
        const value = saved[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    test("a missing git gives no stamp instead of throwing", async () => {
      const dir = repo();
      process.env.PATH = join(dir, "no-such-dir");
      process.env.Path = process.env.PATH;
      expect(await workingTreeStamp(dir)).toBeNull();
    });

    test("a missing temp directory gives no stamp instead of throwing", async () => {
      const dir = repo();
      const missing = join(dir, "no-such-dir");
      for (const name of ["TMPDIR", "TEMP", "TMP"]) process.env[name] = missing;
      expect(await workingTreeStamp(dir)).toBeNull();
    });
  });
});
