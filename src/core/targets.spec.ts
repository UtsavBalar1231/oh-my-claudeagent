import { describe, expect, test } from "bun:test";
import type { Context } from "./shell.ts";
import { isCatastrophicTarget } from "./targets.ts";

const POSIX: Context = { shell: "bash", home: "/home/bob", cwd: "/home/bob/proj/sub", root: "/home/bob/proj" };
const WINDOWS: Context = {
  shell: "powershell",
  home: "C:\\Users\\x",
  cwd: "C:\\Users\\x\\proj\\sub",
  root: "C:\\Users\\x\\proj",
};

describe("a relative target is resolved against the working directory", () => {
  test.each([
    ["..", true],
    ["../..", true],
    ["../sub", true],
    ["../sub/", true],
    ["./../sub", true],
    ["../../proj", true],
    ["../../proj/*", true],
    ["../../proj/sub/..", true],
    ["../../../bob", true],
    ["*", true],
    ["./*", true],
    [".*", true],
    ["sub/..", true],
    ["../other", false],
    ["../other/build", false],
    ["./build", false],
    ["build", false],
    ["build/out", false],
    ["build/*", false],
    ["./sub", false],
    ["sub/../build", false],
    ["*.o", false],
  ])("on POSIX, %s is catastrophic: %p", (target, expected) =>
    expect(isCatastrophicTarget(target, POSIX)).toBe(expected));

  test.each([
    ["..\\sub", true],
    ["..\\..", true],
    ["..\\..\\proj", true],
    ["..\\..\\proj\\*", true],
    ["../sub", true],
    ["..\\other", false],
    [".\\build", false],
    ["build\\out", false],
    ["build\\*", false],
  ])("on Windows, %s is catastrophic: %p", (target, expected) =>
    expect(isCatastrophicTarget(target, WINDOWS)).toBe(expected));

  test("a path below the working directory is never catastrophic, however shallow the directory", () => {
    expect(isCatastrophicTarget("build", { shell: "bash", home: "/home/bob", cwd: "/home/bob" })).toBe(false);
    expect(isCatastrophicTarget("lib", { shell: "bash", cwd: "/usr" })).toBe(false);
    expect(isCatastrophicTarget("Users", { shell: "powershell", cwd: "C:\\" })).toBe(false);
  });

  test("a path beside a shallow working directory is judged as the absolute path it names", () => {
    expect(isCatastrophicTarget("../bob2", { shell: "bash", home: "/home/bob", cwd: "/home/bob" })).toBe(false);
    expect(isCatastrophicTarget("../etc", { shell: "bash", cwd: "/usr" })).toBe(true);
    expect(isCatastrophicTarget("../share", { shell: "bash", cwd: "/usr/lib" })).toBe(false);
  });

  test("without a usable working directory a relative path keeps the reading it had", () => {
    expect(isCatastrophicTarget("../sub", { shell: "bash" })).toBe(false);
    expect(isCatastrophicTarget("../sub", { shell: "bash", home: "/home/bob", root: "/home/bob/proj" })).toBe(false);
    expect(isCatastrophicTarget("../sub", { shell: "bash", cwd: "proj/sub" })).toBe(false);
    expect(isCatastrophicTarget("..", { shell: "bash" })).toBe(true);
    expect(isCatastrophicTarget("../..", { shell: "bash", cwd: "proj/sub" })).toBe(true);
  });

  test.each([
    ["bash", "$PWD", true],
    ["bash", "${PWD}", true],
    ["bash", "$(pwd)", true],
    ["bash", "`pwd`", true],
    ["bash", '"$PWD"', true],
    ["bash", "$(pwd)/..", true],
    ["bash", "$PWD/*", true],
    ["bash", "$PWD/build", false],
    ["bash", "${PWD}/build/out", false],
    ["bash", "$(pwd)/build", false],
    ["bash", "`pwd`/build", false],
    ["bash", '"$(pwd)/build"', false],
    ["bash", "$PWD/../other", false],
    ["bash", "$PWDX/build", true],
    ["bash", "$pwd/build", true],
    ["powershell", "$PWD", true],
    ["powershell", "$pwd", true],
    ["powershell", "(Get-Location)", true],
    ["powershell", "$(Get-Location)", true],
    ["powershell", "(pwd)", true],
    ["powershell", "$PWD\\..", true],
    ["powershell", "$PWD\\build", false],
    ["powershell", "$pwd/build", false],
    ["powershell", "(Get-Location)\\build", false],
    ["powershell", "$(Get-Location)\\build", false],
    ["powershell", "(pwd)\\build", false],
  ] as const)("in %s, %s is catastrophic: %p, with the working directory known or not", (shell, target, expected) => {
    expect(isCatastrophicTarget(target, { ...POSIX, shell })).toBe(expected);
    expect(isCatastrophicTarget(target, { shell })).toBe(expected);
    expect(isCatastrophicTarget(target, { shell, cwd: "proj/sub" })).toBe(expected);
  });

  test("an absolute target and a home or variable-led one are not read against the working directory", () => {
    expect(isCatastrophicTarget("/tmp/a/b", POSIX)).toBe(false);
    expect(isCatastrophicTarget("/home/bob/proj/sub", POSIX)).toBe(true);
    expect(isCatastrophicTarget("~/dev", POSIX)).toBe(true);
    expect(isCatastrophicTarget("~/dev/x", POSIX)).toBe(false);
    expect(isCatastrophicTarget("$DIR/build", POSIX)).toBe(true);
  });
});
