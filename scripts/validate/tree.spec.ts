import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createContext } from "./core.ts";
import { cleanup, fixture, runNamed } from "./fixture.ts";
import { checks, shellOrPythonScripts } from "./tree.ts";

afterEach(cleanup);

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

describe("shell and python scripts", () => {
  const check = (patch: Record<string, string>) => runNamed(checks, "shell and python scripts", fixture(patch));

  test("a tree without interpreter scripts passes", async () => {
    expect(await check({ "scripts/tool.ts": "#!/usr/bin/env bun\n" })).toEqual({ status: "pass", detail: "no tracked python, bash or sh script" });
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
  ])("a script with %p fails whatever its name", async (shebang) => {
    expect(await check({ "scripts/new-hook": `${shebang}\nexit 0\n` })).toEqual({
      status: "fail",
      detail: "scripts/new-hook is a python, bash or sh script",
    });
  });

  test.each(["servers/x.py", "scripts/hook.sh", "hooks/run.bash"])("%s fails with no shebang", async (path) => {
    expect(await check({ [path]: "print(1)\n" })).toEqual({ status: "fail", detail: `${path} is a python, bash or sh script` });
  });

  test.each(["#!/usr/bin/env bun", "#!/usr/bin/env node", "#!/usr/bin/env fish", "#!/bin/zsh", "echo bash", "# #!/bin/bash"])(
    "%p is not a python, bash or sh shebang",
    async (first) => {
      expect(await check({ "scripts/tool.ts": `${first}\n` })).toMatchObject({ status: "pass" });
    },
  );

  test("the real tree has no python, bash or sh script", () => {
    expect(shellOrPythonScripts(createContext(join(import.meta.dir, "..", "..")))).toEqual([]);
  });
});
