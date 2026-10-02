import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createContext } from "./core.ts";
import { cleanup, fixture, runNamed } from "./fixture.ts";
import { checks, SHEBANG_ALLOWLIST, shebangScripts } from "./tree.ts";

afterEach(cleanup);

const ALLOWED = Object.fromEntries(Object.keys(SHEBANG_ALLOWLIST).map((path) => [path, "#!/usr/bin/env bash\necho ok\n"]));

describe("core imports", () => {
  test.each([
    ['import { readFileSync } from "node:fs";', "named import"],
    ["import * as path from 'node:path';", "namespace import"],
    ['import "node:fs";', "bare import"],
    ['const fs = await import("node:fs");', "dynamic import"],
    ['const fs = require("bun:sqlite");', "require"],
    ['import type { Stats } from "node:fs";', "type import"],
    ['export { x } from "bun:ffi";', "re-export"],
  ])("%s (%s) fails", async (line) => {
    const ctx = fixture({ "src/core/io.ts": `${line}\n` });
    expect(await runNamed(checks, "core imports", ctx)).toEqual({ status: "fail", detail: "src/core/io.ts imports node: or bun:" });
  });

  test("a spec, a relative import and a package named like a protocol are fine", async () => {
    const ctx = fixture({
      "src/core/io.spec.ts": 'import { test } from "bun:test";\nimport { readFileSync } from "node:fs";\n',
      "src/core/io.ts": 'import { path } from "./path.ts";\nconst note = "node:fs is not imported here";\n',
    });
    expect(await runNamed(checks, "core imports", ctx)).toMatchObject({ status: "pass" });
  });

  test("a node: import outside src/core is not this check's business", async () => {
    const ctx = fixture({ "servers/io.ts": 'import { readFileSync } from "node:fs";\n' });
    expect(await runNamed(checks, "core imports", ctx)).toMatchObject({ status: "pass" });
  });
});

describe("test file location", () => {
  test("a *.test.ts outside tests/mod fails and names the file", async () => {
    const ctx = fixture({ "src/core/path.test.ts": "export {};\n", "scripts/a.test.ts": "export {};\n" });
    expect(await runNamed(checks, "test file location", ctx)).toEqual({
      status: "fail",
      detail: "src/core/path.test.ts is a *.test.ts outside tests/mod/; scripts/a.test.ts is a *.test.ts outside tests/mod/",
    });
  });

  test("tests/mod holds *.test.ts and a *.spec.ts lives anywhere", async () => {
    const ctx = fixture({ "tests/mod/band.test.ts": "export {};\n", "src/core/path.spec.ts": "export {};\n" });
    expect(await runNamed(checks, "test file location", ctx)).toMatchObject({ status: "pass" });
  });
});

describe("shebang scripts", () => {
  test("the allowlisted scripts alone pass", async () => {
    expect(await runNamed(checks, "shebang scripts", fixture(ALLOWED))).toMatchObject({ status: "pass" });
  });

  test.each([
    "#!/bin/bash",
    "#!/bin/sh",
    "#!/usr/bin/env bash",
    "#!/usr/bin/env sh",
    "#!/usr/bin/env python3",
    "#!/usr/bin/python",
    "#!/usr/bin/env -S python3 -u",
    "#! /bin/bash -e",
  ])("a new script with %p fails", async (shebang) => {
    const ctx = fixture({ ...ALLOWED, "scripts/new-hook.sh": `${shebang}\nexit 0\n` });
    expect(await runNamed(checks, "shebang scripts", ctx)).toEqual({
      status: "fail",
      detail: "scripts/new-hook.sh has a python, bash or sh shebang",
    });
  });

  test.each(["#!/usr/bin/env bun", "#!/usr/bin/env node", "#!/usr/bin/env fish", "#!/bin/zsh", "echo bash", "# #!/bin/bash"])(
    "%p is not a python, bash or sh shebang",
    async (first) => {
      const ctx = fixture({ ...ALLOWED, "scripts/tool.ts": `${first}\n` });
      expect(await runNamed(checks, "shebang scripts", ctx)).toMatchObject({ status: "pass" });
    },
  );

  test("an allowlisted script that lost its shebang or was deleted fails as stale", async () => {
    const path = "tests/evals/run-eval.sh";
    const stripped = fixture({ ...ALLOWED, [path]: "echo ok\n" });
    expect(await runNamed(checks, "shebang scripts", stripped)).toEqual({
      status: "fail",
      detail: `${path} is allowlisted but is gone or has no such shebang`,
    });
    const gone = fixture({ ...ALLOWED, [path]: null });
    expect(await runNamed(checks, "shebang scripts", gone)).toEqual({
      status: "fail",
      detail: `${path} is allowlisted but is gone or has no such shebang`,
    });
  });

  test("every allowlist entry carries a reason", () => {
    for (const [path, reason] of Object.entries(SHEBANG_ALLOWLIST)) expect([path, reason.length > 10]).toEqual([path, true]);
  });

  test("the real tree's shebang scripts are exactly the allowlisted ones", () => {
    const ctx = createContext(join(import.meta.dir, "..", ".."));
    expect(shebangScripts(ctx).sort()).toEqual(Object.keys(SHEBANG_ALLOWLIST).sort());
  });
});
