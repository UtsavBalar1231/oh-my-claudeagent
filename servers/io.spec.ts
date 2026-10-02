import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureStateDir, LOCK_STALE_MS, projectRoot, withLock, writeFileAtomic } from "./io.ts";

const IO_MODULE = join(import.meta.dir, "io.ts");

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "omca-io-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const gitInit = (path: string) => {
  expect(Bun.spawnSync(["git", "init", "-q", path]).exitCode).toBe(0);
};

async function deadPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, "-e", ""]);
  await child.exited;
  return child.pid;
}

describe("projectRoot", () => {
  test("a directory inside a repository resolves to the repository's top level", () => {
    gitInit(dir);
    const nested = join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(projectRoot(nested)).toBe(dir);
  });

  test("a directory outside any repository resolves to itself", () => {
    const ceiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = dir;
    try {
      const outside = join(dir, "plain");
      mkdirSync(outside);
      expect(projectRoot(outside)).toBe(outside);
    } finally {
      if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = ceiling;
    }
  });
});

describe("ensureStateDir", () => {
  test("creates .omca/state and drops the ignore-everything-but-rules .gitignore", () => {
    expect(existsSync(join(dir, ".omca"))).toBe(false);
    expect(ensureStateDir(dir)).toBe(join(dir, ".omca", "state"));
    expect(existsSync(join(dir, ".omca", "state"))).toBe(true);
    expect(readFileSync(join(dir, ".omca", ".gitignore"), "utf8")).toBe("*\n!/rules/\n");
  });

  test("leaves an existing .omca/.gitignore untouched", () => {
    mkdirSync(join(dir, ".omca"));
    writeFileSync(join(dir, ".omca", ".gitignore"), "custom content\n");
    ensureStateDir(dir);
    expect(readFileSync(join(dir, ".omca", ".gitignore"), "utf8")).toBe("custom content\n");
  });

});

describe("writeFileAtomic", () => {
  test("replaces the file's content and leaves no temp file behind", () => {
    const path = join(dir, "state", "data.json");
    writeFileAtomic(path, "first");
    writeFileAtomic(path, "second");
    expect(readFileSync(path, "utf8")).toBe("second");
    expect(readdirSync(join(dir, "state"))).toEqual(["data.json"]);
  });
});

describe("withLock", () => {
  const lockFiles = () => readdirSync(dir).filter((name) => name.startsWith("data.lock"));

  test("runs the function, returns its value and removes the lock", async () => {
    const lock = join(dir, "data.lock");
    expect(await withLock(lock, () => 42)).toBe(42);
    expect(lockFiles()).toEqual([]);
  });

  test("the lock holds pid, epoch milliseconds and a token while the function runs", async () => {
    const lock = join(dir, "data.lock");
    const before = Date.now();
    const content = await withLock(lock, () => readFileSync(lock, "utf8"));
    const [pid, at, token] = content.split(" ");
    expect(Number(pid)).toBe(process.pid);
    expect(Number(at)).toBeGreaterThanOrEqual(before);
    expect(Number(at)).toBeLessThanOrEqual(Date.now());
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("releases the lock when the function throws", async () => {
    const lock = join(dir, "data.lock");
    await expect(
      withLock(lock, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(lockFiles()).toEqual([]);
  });

  test("a lock held by a live pid within 30 s is not broken, and the wait times out", async () => {
    const lock = join(dir, "data.lock");
    const held = `${process.pid} ${Date.now()} other-holder`;
    writeFileSync(lock, held);
    let ran = false;
    await expect(
      withLock(lock, () => {
        ran = true;
      }, 150),
    ).rejects.toThrow(`timed out after 150 ms waiting for ${lock}`);
    expect(ran).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe(held);
  });

  test("a lock held by a live pid for longer than 30 s is broken", async () => {
    const lock = join(dir, "data.lock");
    writeFileSync(lock, `${process.pid} ${Date.now() - LOCK_STALE_MS - 1_000} slow-holder`);
    expect(await withLock(lock, () => "acquired", 1_000)).toBe("acquired");
    expect(lockFiles()).toEqual([]);
  });

  const staleLocks: Array<[string, () => Promise<string>]> = [
    ["an empty lock", async () => ""],
    ["an unparsable lock", async () => "not a lock"],
    ["a dead-pid lock", async () => `${await deadPid()} ${Date.now()} dead-holder`],
  ];

  for (const [label, content] of staleLocks) {
    test(`${label} is broken only through the .break lock`, async () => {
      const lock = join(dir, "data.lock");
      const stale = await content();
      writeFileSync(lock, stale);
      writeFileSync(`${lock}.break`, `${process.pid} ${Date.now()} live-breaker`);
      await expect(withLock(lock, () => "acquired", 150)).rejects.toThrow("timed out");
      expect(readFileSync(lock, "utf8")).toBe(stale);

      rmSync(`${lock}.break`);
      expect(await withLock(lock, () => "acquired", 1_000)).toBe("acquired");
      expect(lockFiles()).toEqual([]);
    });
  }

  test("a .break lock left by a dead pid is cleared so a stale lock can still be broken", async () => {
    const lock = join(dir, "data.lock");
    writeFileSync(lock, "");
    writeFileSync(`${lock}.break`, `${await deadPid()} ${Date.now()} dead-breaker`);
    expect(await withLock(lock, () => "acquired", 1_000)).toBe("acquired");
    expect(lockFiles()).toEqual([]);
  });

  test("release leaves a lock that holds another holder's token", async () => {
    const lock = join(dir, "data.lock");
    const other = `${process.pid} ${Date.now()} other-holder`;
    await withLock(lock, () => writeFileSync(lock, other));
    expect(readFileSync(lock, "utf8")).toBe(other);
  });
});

describe("withLock across processes", () => {
  const appender = () => {
    const path = join(dir, "append.ts");
    writeFileSync(
      path,
      `import { existsSync, readFileSync } from "node:fs";
import { withLock, writeFileAtomic } from ${JSON.stringify(IO_MODULE)};
const [file, label, count] = process.argv.slice(2);
await Promise.all(
  Array.from({ length: Number(count) }, (_, i) =>
    withLock(file + ".lock", () => {
      const entries = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
      entries.push(label + "-" + i);
      writeFileAtomic(file, JSON.stringify(entries));
    }),
  ),
);
`,
    );
    return path;
  };

  async function appendConcurrently(processes: number, perProcess: number): Promise<string[]> {
    const script = appender();
    const ledger = join(dir, "ledger.json");
    const children = Array.from({ length: processes }, (_, p) =>
      Bun.spawn([process.execPath, script, ledger, `p${p}`, String(perProcess)], { stderr: "pipe" }),
    );
    const codes = await Promise.all(children.map((child) => child.exited));
    const stderr = await Promise.all(children.map((child) => new Response(child.stderr).text()));
    expect(stderr.filter(Boolean)).toEqual([]);
    expect(codes).toEqual(Array(processes).fill(0));
    return JSON.parse(readFileSync(ledger, "utf8"));
  }

  const expected = (processes: number, perProcess: number) =>
    Array.from({ length: processes }, (_, p) => Array.from({ length: perProcess }, (_, i) => `p${p}-${i}`))
      .flat()
      .sort();

  test("two sessions appending 100 entries each lose none", async () => {
    const entries = await appendConcurrently(2, 100);
    expect(entries.sort()).toEqual(expected(2, 100));
    expect(readdirSync(dir).sort()).toEqual(["append.ts", "ledger.json"]);
  }, 30_000);

  test("eight processes appending 100 entries each lose none", async () => {
    const entries = await appendConcurrently(8, 100);
    expect(entries.sort()).toEqual(expected(8, 100));
    expect(readdirSync(dir).sort()).toEqual(["append.ts", "ledger.json"]);
  }, 30_000);
});
