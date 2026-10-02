import { expect, test } from "bun:test";
import { isPlanPath } from "./plan-path.ts";

test.each([
  ["/home/user/.claude/plans/my-agent-abc123.md", true],
  ["/home/user/.claude/plans/cool-cooking-sifakis-agent-deadbeef.md", true],
  ["/plans/x.md", true],
  ["/a/plans/plans/x.md", true],
  ["/tmp/notes.md", false],
  ["plans/x.md", false],
  ["/a/myplans/x.md", false],
  ["/a/plans/sub/x.md", false],
  ["/a/plans/x.md.bak", false],
  ["/a/plans/x.txt", false],
  ["/a/plans/.md", false],
  ["/a/plans/", false],
  ["C:\\Users\\x\\.claude\\plans\\p.md", true],
  ["c:\\users\\x\\.claude\\plans\\p.md", true],
  ["C:/Users/x/.claude/plans/p.md", true],
  ["/c/Users/x/.claude/plans/p.md", true],
  ["\\\\srv\\share\\.claude\\plans\\p.md", true],
  ["/Users/Me/.claude/plans/p.md", true],
  ["C:\\Users\\x\\.claude\\plans\\sub\\p.md", false],
  ["C:\\Users\\x\\.claude\\myplans\\p.md", false],
  ["C:\\Users\\x\\.claude\\plans\\p.txt", false],
  ["C:\\Users\\x\\notes\\p.md", false],
  ["plans\\p.md", false],
])("isPlanPath(%p) is %p", (path, expected) => {
  expect(isPlanPath(path)).toBe(expected);
});
