import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { ensureStateDir, LOCK_STALE_MS, projectRoot, tryWithLockSync, withLock, writeFileAtomic } from "./io.ts";

const IO_MODULE = join(import.meta.dir, "io.ts");

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "omca-io-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const gitInit = (path: string) => {
  expect(Bun.spawnSync(["git", "init", "-q", path], { env: process.env }).exitCode).toBe(0);
};

const HOST = hostname();
const errno = (code: string) => Object.assign(new Error(`${code}: injected`), { code });
const holder = (pid: number, ageMs = 0, host = HOST) => `${pid} ${Date.now() - ageMs} spec-holder ${host}`;

async function deadPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, "-e", ""], { env: process.env });
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

  test("a directory outside any repository resolves to itself without a log line", () => {
    const ceiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = dir;
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const outside = join(dir, "plain");
      mkdirSync(outside);
      expect(projectRoot(outside)).toBe(outside);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = ceiling;
    }
  });

  test("any other git failure falls back to the directory and is reported once for it", () => {
    gitInit(dir);
    writeFileSync(join(dir, ".git", "config"), "[[[\n");
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(projectRoot(dir)).toBe(dir);
      expect(projectRoot(dir)).toBe(dir);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]?.[0])).toMatch(
        new RegExp(`^omca: git rev-parse --show-toplevel failed in ${RegExp.escape(dir)}; using it as the project root: fatal: bad config`),
      );
    } finally {
      errors.mockRestore();
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
    const [pid, at, token, host] = content.split(" ");
    expect(host).toBe(HOST);
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
    ["a dead-pid lock", async () => holder(await deadPid())],
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
    writeFileSync(`${lock}.break`, holder(await deadPid()));
    expect(await withLock(lock, () => "acquired", 1_000)).toBe("acquired");
    expect(lockFiles()).toEqual([]);
  });

  test("a lock whose holder is on another host is judged by age alone, whatever its pid", async () => {
    const lock = join(dir, "data.lock");
    const foreign = holder(await deadPid(), 0, "other-machine");
    writeFileSync(lock, foreign);
    await expect(withLock(lock, () => "acquired", 150)).rejects.toThrow("timed out");
    expect(readFileSync(lock, "utf8")).toBe(foreign);

    writeFileSync(lock, holder(process.pid, LOCK_STALE_MS + 1_000, "other-machine"));
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

describe("tryWithLockSync", () => {
  test("runs the function under the lock and removes the lock", () => {
    const lock = join(dir, "data.lock");
    let seen = "";
    expect(tryWithLockSync(lock, () => (seen = readFileSync(lock, "utf8")), 0)).toBe(true);
    expect(seen.split(" ")[0]).toBe(String(process.pid));
    expect(existsSync(lock)).toBe(false);
  });

  test("gives up on a live holder once its wait runs out, running nothing", () => {
    const lock = join(dir, "data.lock");
    const held = `${process.pid} ${Date.now()} other-holder`;
    writeFileSync(lock, held);
    let ran = false;
    const started = performance.now();
    expect(tryWithLockSync(lock, () => (ran = true), 30)).toBe(false);
    const elapsed = performance.now() - started;
    // The deadline is kept in whole Date.now() milliseconds, so the wait can end up to 1 ms early.
    expect(elapsed).toBeGreaterThanOrEqual(29);
    expect(elapsed).toBeLessThan(500);
    expect(ran).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe(held);
  });

  test("breaks a dead holder's lock", async () => {
    const lock = join(dir, "data.lock");
    writeFileSync(lock, holder(await deadPid()));
    expect(tryWithLockSync(lock, () => {}, 0)).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });
});

describe("under injected filesystem faults", () => {
  const lockFiles = () => readdirSync(dir).filter((name) => name.startsWith("data.lock"));
  const only = (path: unknown, target: string) => String(path) === target;

  test("a filesystem that refuses hard links gets a lock directory, taken and released with the same token", async () => {
    const lock = join(dir, "data.lock");
    const link = spyOn(fs, "linkSync").mockImplementation(() => {
      throw errno("EPERM");
    });
    try {
      const seen = await withLock(lock, () => ({
        file: existsSync(lock),
        owner: readFileSync(join(`${lock}.d`, "owner"), "utf8"),
        entries: readdirSync(`${lock}.d`),
      }));
      expect(seen.file).toBe(false);
      expect(seen.entries).toEqual(["owner"]);
      const [pid, at, token, host] = seen.owner.split(" ");
      expect([Number(pid), host]).toEqual([process.pid, HOST]);
      expect(Number(at)).toBeGreaterThan(0);
      expect(token).toMatch(/^[0-9a-f-]{36}$/);
      expect(link).toHaveBeenCalled();
      expect(lockFiles()).toEqual([]);
    } finally {
      link.mockRestore();
    }
  });

  for (const code of ["ENOSYS", "EOPNOTSUPP", "EINVAL"]) {
    test(`a link refused with ${code} falls back to the lock directory too`, async () => {
      const lock = join(dir, "data.lock");
      const link = spyOn(fs, "linkSync").mockImplementation(() => {
        throw errno(code);
      });
      try {
        expect(await withLock(lock, () => existsSync(`${lock}.d`))).toBe(true);
        expect(lockFiles()).toEqual([]);
      } finally {
        link.mockRestore();
      }
    });
  }

  test("a link refused with an unlisted code is an error, not a fallback", async () => {
    const lock = join(dir, "data.lock");
    const link = spyOn(fs, "linkSync").mockImplementation(() => {
      throw errno("ENOSPC");
    });
    try {
      await expect(withLock(lock, () => "never")).rejects.toThrow("ENOSPC");
      expect(lockFiles()).toEqual([]);
    } finally {
      link.mockRestore();
    }
  });

  test("a held lock directory excludes a second taker until released", async () => {
    const lock = join(dir, "data.lock");
    const link = spyOn(fs, "linkSync").mockImplementation(() => {
      throw errno("EPERM");
    });
    try {
      let rival: string | undefined;
      await withLock(lock, async () => {
        rival = await withLock(lock, () => "inside", 100).catch((error: Error) => error.message);
      });
      expect(rival).toBe(`timed out after 100 ms waiting for ${lock}`);
      expect(await withLock(lock, () => "after")).toBe("after");
      expect(lockFiles()).toEqual([]);
    } finally {
      link.mockRestore();
    }
  });

  test("a lock directory whose owner is dead or older than 30 s is broken, a live fresh one is not", async () => {
    const lock = join(dir, "data.lock");
    const link = spyOn(fs, "linkSync").mockImplementation(() => {
      throw errno("EPERM");
    });
    try {
      const seed = (token: string) => {
        mkdirSync(`${lock}.d`);
        writeFileSync(join(`${lock}.d`, "owner"), token);
      };
      const live = holder(process.pid);
      seed(live);
      await expect(withLock(lock, () => "acquired", 150)).rejects.toThrow("timed out");
      expect(readFileSync(join(`${lock}.d`, "owner"), "utf8")).toBe(live);

      rmSync(`${lock}.d`, { recursive: true });
      seed(holder(await deadPid()));
      expect(await withLock(lock, () => "acquired", 1_000)).toBe("acquired");

      seed(holder(process.pid, LOCK_STALE_MS + 1_000));
      expect(await withLock(lock, () => "acquired", 1_000)).toBe("acquired");
      expect(lockFiles()).toEqual([]);
    } finally {
      link.mockRestore();
    }
  });

  test("a lock directory with no owner file is held while fresh and broken once 30 s old", async () => {
    const lock = join(dir, "data.lock");
    const link = spyOn(fs, "linkSync").mockImplementation(() => {
      throw errno("EPERM");
    });
    try {
      mkdirSync(`${lock}.d`);
      await expect(withLock(lock, () => "acquired", 150)).rejects.toThrow("timed out");
      const old = (Date.now() - LOCK_STALE_MS - 1_000) / 1000;
      utimesSync(`${lock}.d`, old, old);
      expect(await withLock(lock, () => "acquired", 1_000)).toBe("acquired");
      expect(lockFiles()).toEqual([]);
    } finally {
      link.mockRestore();
    }
  });

  test("a link that succeeded but reported EEXIST because the reply was lost counts as acquired", async () => {
    const lock = join(dir, "data.lock");
    const real = fs.linkSync;
    const link = spyOn(fs, "linkSync").mockImplementation((existing, created) => {
      real(existing, created);
      throw errno("EEXIST");
    });
    try {
      expect(await withLock(lock, () => readFileSync(lock, "utf8").split(" ")[0])).toBe(String(process.pid));
      expect(lockFiles()).toEqual([]);
    } finally {
      link.mockRestore();
    }
  });

  test("an EEXIST from a lock another holder owns is not mistaken for a lost reply", async () => {
    const lock = join(dir, "data.lock");
    const live = holder(process.pid);
    writeFileSync(lock, live);
    await expect(withLock(lock, () => "never", 100)).rejects.toThrow("timed out");
    expect(readFileSync(lock, "utf8")).toBe(live);
  });

  test("a rename that fails EBUSY twice lands on the third try with no temp file left", () => {
    const path = join(dir, "state", "data.json");
    const real = fs.renameSync;
    let failures = 0;
    const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (failures++ < 2) throw errno("EBUSY");
      real(from, to);
    });
    try {
      writeFileAtomic(path, "landed");
      expect(rename).toHaveBeenCalledTimes(3);
    } finally {
      rename.mockRestore();
    }
    expect(readFileSync(path, "utf8")).toBe("landed");
    expect(readdirSync(join(dir, "state"))).toEqual(["data.json"]);
  });

  test("a rename that never stops failing gives up after ten tries, throws its own error and removes the temp file", () => {
    const path = join(dir, "state", "data.json");
    const rename = spyOn(fs, "renameSync").mockImplementation(() => {
      throw errno("EACCES");
    });
    try {
      expect(() => writeFileAtomic(path, "never")).toThrow("EACCES");
      expect(rename).toHaveBeenCalledTimes(10);
    } finally {
      rename.mockRestore();
    }
    expect(readdirSync(join(dir, "state"))).toEqual([]);
  });

  test("a failed rename is not retried for a code that is not a busy file", () => {
    const rename = spyOn(fs, "renameSync").mockImplementation(() => {
      throw errno("ENOSPC");
    });
    try {
      expect(() => writeFileAtomic(join(dir, "data.json"), "x")).toThrow("ENOSPC");
      expect(rename).toHaveBeenCalledTimes(1);
    } finally {
      rename.mockRestore();
    }
  });

  test("an unlink that fails EPERM on release is retried and the lock is released with the function's value intact", async () => {
    const lock = join(dir, "data.lock");
    const real = fs.unlinkSync;
    let failures = 0;
    let attempts = 0;
    const unlink = spyOn(fs, "unlinkSync").mockImplementation((path) => {
      if (only(path, lock)) {
        attempts++;
        if (failures++ < 3) throw errno("EPERM");
      }
      real(path);
    });
    try {
      expect(await withLock(lock, () => "value")).toBe("value");
    } finally {
      unlink.mockRestore();
    }
    expect(attempts).toBe(4);
    expect(lockFiles()).toEqual([]);
  });

  test("an unlink that keeps failing on release is logged, never thrown over the function's result or error", async () => {
    const lock = join(dir, "data.lock");
    const real = fs.unlinkSync;
    const unlink = spyOn(fs, "unlinkSync").mockImplementation((path) => {
      if (only(path, lock)) throw errno("EPERM");
      real(path);
    });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await withLock(lock, () => "value")).toBe("value");
      rmSync(lock);
      await expect(
        withLock(lock, () => {
          throw new Error("work failed");
        }),
      ).rejects.toThrow("work failed");
      expect(errors.mock.calls.filter(([message]) => String(message).startsWith(`omca: releasing ${lock} failed`))).toHaveLength(2);
    } finally {
      unlink.mockRestore();
      errors.mockRestore();
    }
    expect(existsSync(lock)).toBe(true);
  });

  test("a temp link that cannot be removed after a successful link neither throws nor loses the lock", async () => {
    const lock = join(dir, "data.lock");
    const real = fs.rmSync;
    const remove = spyOn(fs, "rmSync").mockImplementation((path, options) => {
      if (String(path).endsWith(".tmp")) throw errno("EBUSY");
      real(path, options);
    });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await withLock(lock, () => "value")).toBe("value");
      expect(errors.mock.calls.some(([message]) => String(message).includes("removing"))).toBe(true);
    } finally {
      remove.mockRestore();
      errors.mockRestore();
    }
    expect(lockFiles().filter((name) => !name.endsWith(".tmp"))).toEqual([]);
  });

  test("a lock file that reads EACCES is treated as busy, so the wait times out instead of failing", async () => {
    const lock = join(dir, "data.lock");
    writeFileSync(lock, holder(process.pid));
    const real = fs.readFileSync;
    const read = spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, options?: unknown) => {
      if (only(path, lock)) throw errno("EACCES");
      return real(path, options as BufferEncoding);
    }) as typeof fs.readFileSync);
    try {
      await expect(withLock(lock, () => "never", 100)).rejects.toThrow(`timed out after 100 ms waiting for ${lock}`);
    } finally {
      read.mockRestore();
    }
  });
});

// Every entry is one serialized read, write and rename, about 18 ms on a Windows runner, so the last of
// 800 waiters queues for far longer than the 10 s default wait. The wait is the load's, not the lock's.
const WAIT_MS = 120_000;

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
    }, ${WAIT_MS}),
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
      Bun.spawn([process.execPath, script, ledger, `p${p}`, String(perProcess)], { env: process.env, stderr: "pipe" }),
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
  }, WAIT_MS);
});
