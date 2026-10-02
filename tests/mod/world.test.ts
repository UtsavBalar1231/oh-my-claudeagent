import { expect, test } from "claude-code/testing";
import { hostSpelling } from "./world.ts";

test("a Windows host's resolved spelling of a POSIX path is restored to the mod's", () => {
  expect(hostSpelling("D:\\work\\.omca\\state\\boulder.json", "linux")).toBe("/work/.omca/state/boulder.json");
  expect(hostSpelling("D:/work/x", "linux")).toBe("/work/x");
  expect(hostSpelling("/work/x", "linux")).toBe("/work/x");
});

test("a drive path keeps its drive and takes the mod's forward slashes on a win32 layout", () => {
  expect(hostSpelling("C:\\Users\\u\\.claude\\settings.json", "win32")).toBe("C:/Users/u/.claude/settings.json");
  expect(hostSpelling("C:/Users/u", "win32")).toBe("C:/Users/u");
  expect(hostSpelling("\\\\srv\\share\\x", "win32")).toBe("\\\\srv\\share\\x");
});
