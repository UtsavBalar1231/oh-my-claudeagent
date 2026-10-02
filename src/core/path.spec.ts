import { describe, expect, test } from "bun:test";
import {
  baseName,
  configDir,
  expandTilde,
  homeDir,
  inferPlatform,
  isAbsolutePath,
  isInside,
  joinPath,
  normalizePath,
  samePath,
  tildePath,
  toPlatform,
  toPosix,
} from "./path.ts";

describe("toPosix", () => {
  test.each([
    ["win32", "C:\\Users\\x\\.claude", "C:/Users/x/.claude"],
    ["win32", "\\\\srv\\share\\plans\\p.md", "//srv/share/plans/p.md"],
    ["win32", "/c/Users/x", "c:/Users/x"],
    ["win32", "/c", "c:/"],
    ["win32", "/cc/Users", "/cc/Users"],
    ["win32", "plans\\p.md", "plans/p.md"],
    ["linux", "C:\\Users\\x", "C:/Users/x"],
    ["linux", "\\\\srv\\share\\x", "//srv/share/x"],
    ["linux", "/c/Users/x", "/c/Users/x"],
    ["linux", "a\\b", "a\\b"],
    ["darwin", "/Users/x/a\\b", "/Users/x/a\\b"],
  ] as const)("%s %p is %p", (platform, path, expected) => {
    expect(toPosix(platform, path)).toBe(expected);
  });
});

describe("isAbsolutePath", () => {
  test.each([
    ["linux", "/x", true],
    ["linux", "X:\\", true],
    ["linux", "X:/", true],
    ["linux", "x:\\dir", true],
    ["linux", "\\\\server\\share", true],
    ["linux", "//server/share", true],
    ["linux", "X:", false],
    ["linux", "X:dir", false],
    ["linux", "dir/x", false],
    ["linux", "\\x", false],
    ["win32", "\\x", true],
    ["win32", "x\\y", false],
    ["win32", "", false],
  ] as const)("%s %p is %p", (platform, path, expected) => {
    expect(isAbsolutePath(platform, path)).toBe(expected);
  });
});

describe("baseName", () => {
  test.each([
    ["linux", "/a/b/c.md", "c.md"],
    ["linux", "/a/b/", "b"],
    ["linux", "c.md", "c.md"],
    ["linux", "/", ""],
    ["linux", "", ""],
    ["win32", "C:\\Users\\x\\.claude\\plans\\p.md", "p.md"],
    ["win32", "C:\\", ""],
    ["win32", "C:/Users/x/p.md", "p.md"],
    ["win32", "/c/Users/x/p.md", "p.md"],
    ["win32", "\\\\srv\\share\\dir\\p.md", "p.md"],
    ["win32", "\\\\srv\\share", ""],
    ["linux", "C:\\Users\\x\\p.md", "p.md"],
    ["darwin", "/Users/Me/p.md", "p.md"],
  ] as const)("%s %p is %p", (platform, path, expected) => {
    expect(baseName(platform, path)).toBe(expected);
  });
});

describe("normalizePath and joinPath", () => {
  test.each([
    ["linux", "/a/./b//c/../d", "/a/b/d"],
    ["linux", "/..", "/"],
    ["linux", "a/../../b", "../b"],
    ["linux", "", "."],
    ["win32", "C:\\proj\\.plans", "C:/proj/.plans"],
    ["win32", "C:\\proj\\a\\..\\..\\..\\b", "C:/b"],
    ["win32", "C:\\", "C:/"],
    ["win32", "c:/Users//x/", "c:/Users/x"],
    ["win32", "\\\\srv\\share\\a\\..\\b", "//srv/share/b"],
    ["win32", "\\\\srv\\share\\..\\..", "//srv/share/"],
    ["win32", "/c/Users/x/../y", "c:/Users/y"],
  ] as const)("%s normalizes %p to %p", (platform, path, expected) => {
    expect(normalizePath(platform, path)).toBe(expected);
  });

  test("joinPath keeps the drive or UNC prefix and skips empty parts", () => {
    expect(joinPath("win32", "C:\\Users\\x", ".claude", "plans")).toBe("C:/Users/x/.claude/plans");
    expect(joinPath("win32", "C:/proj", "", "docs\\plans")).toBe("C:/proj/docs/plans");
    expect(joinPath("win32", "\\\\srv\\share", "plans")).toBe("//srv/share/plans");
    expect(joinPath("linux", "/home/u", "..", "v", ".claude")).toBe("/home/v/.claude");
    expect(joinPath("darwin", "/Users/Me", ".claude")).toBe("/Users/Me/.claude");
  });
});

describe("samePath", () => {
  test.each([
    ["linux", "/home/u/a", "/home/u/a/", true],
    ["linux", "/home/u/a", "/home/u/A", false],
    ["linux", "C:\\Users\\x", "c:/Users/x", true],
    ["linux", "C:\\Users\\x", "c:/users/x", false],
    ["darwin", "/Users/Me/.claude", "/users/me/.CLAUDE", true],
    ["darwin", "/Users/Me", "/Users/Me2", false],
    ["win32", "C:\\Users\\X\\p.md", "c:/users/x/P.MD", true],
    ["win32", "\\\\SRV\\Share\\p", "//srv/share/p", true],
    ["win32", "/c/Users/x", "C:\\Users\\x", true],
    ["win32", "C:\\a", "D:\\a", false],
  ] as const)("%s %p vs %p is %p", (platform, a, b, expected) => {
    expect(samePath(platform, a, b)).toBe(expected);
  });
});

describe("isInside", () => {
  test.each([
    ["linux", "/work", "/work", true],
    ["linux", "/work", "/work/plans", true],
    ["linux", "/work", "/workshop", false],
    ["linux", "/work", "/work/../etc", false],
    ["linux", "/", "/etc", true],
    ["linux", "/work", "/Work/plans", false],
    ["darwin", "/Users/me/proj", "/users/ME/proj/.plans", true],
    ["win32", "C:\\proj", "c:/PROJ/.plans", true],
    ["win32", "C:\\proj", "C:\\proj2", false],
    ["win32", "C:\\", "C:\\x", true],
    ["win32", "C:\\proj", "D:\\proj\\x", false],
    ["win32", "\\\\srv\\share", "\\\\srv\\share\\x", true],
    ["win32", "\\\\srv\\share", "\\\\srv\\other\\x", false],
    ["linux", "C:\\proj", "c:\\proj\\x", true],
  ] as const)("%s %p contains %p is %p", (platform, parent, child, expected) => {
    expect(isInside(platform, parent, child)).toBe(expected);
  });
});

describe("tildePath", () => {
  test.each([
    ["linux", "/home/u/.claude/plans/x.md", "/home/u", "~/.claude/plans/x.md"],
    ["linux", "/tmp/x.md", "/home/u", "/tmp/x.md"],
    ["linux", "/home/u", "/home/u", "/home/u"],
    ["linux", "/home/user/x", "/home/u", "/home/user/x"],
    ["linux", "/home/u/x", "", "/home/u/x"],
    ["linux", "/etc/x", "/", "/etc/x"],
    ["darwin", "/Users/Utsav/.claude/plans/x.md", "/users/utsav", "~/.claude/plans/x.md"],
    ["win32", "C:\\Users\\x\\.claude\\settings.json", "C:\\Users\\x", "~/.claude/settings.json"],
    ["win32", "c:/users/X/.claude/settings.json", "C:\\Users\\x", "~/.claude/settings.json"],
    ["win32", "D:\\Users\\x\\a", "C:\\Users\\x", "D:\\Users\\x\\a"],
    ["win32", "/c/Users/x/a", "C:\\Users\\x", "~/a"],
  ] as const)("%s %p under home %p is %p", (platform, path, home, expected) => {
    expect(tildePath(platform, path, home)).toBe(expected);
  });
});

describe("expandTilde", () => {
  test.each([
    ["linux", "~/notes/p.md", "/home/u", "/home/u/notes/p.md"],
    ["linux", "~", "/home/u", "/home/u"],
    ["linux", "/tmp/p.md", "/home/u", "/tmp/p.md"],
    ["linux", "~other/p.md", "/home/u", "~other/p.md"],
    ["linux", "~\\p.md", "/home/u", "~\\p.md"],
    ["win32", "~\\notes\\p.md", "C:\\Users\\x", "C:/Users/x/notes/p.md"],
    ["win32", "~/notes/p.md", "C:\\Users\\x", "C:/Users/x/notes/p.md"],
    ["win32", "C:\\p.md", "C:\\Users\\x", "C:\\p.md"],
    ["win32", "~/p.md", undefined, undefined],
    ["win32", "~", "", undefined],
    ["win32", "p.md", undefined, "p.md"],
  ] as const)("%s %p with home %p is %p", (platform, path, home, expected) => {
    expect(expandTilde(platform, path, home)).toBe(expected);
  });
});

describe("homeDir and configDir", () => {
  test("HOME wins, then USERPROFILE, then HOMEDRIVE with HOMEPATH", () => {
    expect(homeDir({ HOME: "/home/u", USERPROFILE: "C:\\Users\\x" })).toBe("/home/u");
    expect(homeDir({ HOME: "", USERPROFILE: "C:\\Users\\x" })).toBe("C:/Users/x");
    expect(homeDir({ USERPROFILE: "", HOMEDRIVE: "C:", HOMEPATH: "\\Users\\x" })).toBe("C:/Users/x");
    expect(homeDir({ HOMEDRIVE: "C:" })).toBeUndefined();
    expect(homeDir({ HOMEPATH: "\\Users\\x" })).toBeUndefined();
    expect(homeDir({})).toBeUndefined();
    expect(homeDir({ HOME: "/home/u/" })).toBe("/home/u");
  });

  test("CLAUDE_CONFIG_DIR wins over <home>/.claude, and neither resolving gives undefined", () => {
    expect(configDir({ HOME: "/home/u", CLAUDE_CONFIG_DIR: "/cfg" })).toBe("/cfg");
    expect(configDir({ HOME: "/home/u", CLAUDE_CONFIG_DIR: "D:\\cfg\\" })).toBe("D:/cfg");
    expect(configDir({ HOME: "/home/u", CLAUDE_CONFIG_DIR: "" })).toBe("/home/u/.claude");
    expect(configDir({ USERPROFILE: "C:\\Users\\x" })).toBe("C:/Users/x/.claude");
    expect(configDir({ HOMEDRIVE: "C:", HOMEPATH: "\\Users\\x" })).toBe("C:/Users/x/.claude");
    expect(configDir({})).toBeUndefined();
    expect(configDir({ HOME: "" })).toBeUndefined();
  });
});

describe("platform detection", () => {
  test("toPlatform keeps win32 and darwin and reads every other name as linux", () => {
    expect(["win32", "darwin", "linux", "freebsd", "aix"].map(toPlatform)).toEqual(["win32", "darwin", "linux", "linux", "linux"]);
  });

  test("inferPlatform reads a drive or UNC path as win32 and a macOS root as darwin", () => {
    expect(inferPlatform("C:\\work", "/home/u")).toBe("win32");
    expect(inferPlatform("\\\\srv\\share")).toBe("win32");
    expect(inferPlatform("/Users/Me/proj")).toBe("darwin");
    expect(inferPlatform("/Volumes/disk/x")).toBe("darwin");
    expect(inferPlatform("/work", "/home/u")).toBe("linux");
    expect(inferPlatform()).toBe("linux");
  });
});
