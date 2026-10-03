import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fixture, VALID } from "./fixture.ts";
import { checks } from "./policy.ts";

afterEach(cleanup);

const [policy] = checks;
if (policy === undefined) throw new Error("policy.ts exports no check");

const without = (source: string | undefined, text: string): string => (source ?? "").replace(text, "");

describe("policy markers", () => {
  test("a tree carrying every marker passes", async () => {
    expect(await policy.run(fixture())).toMatchObject({ status: "pass" });
  });

  test("a posture marker missing from docs/references.md fails and names the marker", async () => {
    const ctx = fixture({ "docs/references.md": without(VALID["docs/references.md"], "sandbox.failIfUnavailable") });
    expect(await policy.run(ctx)).toEqual({
      status: "fail",
      detail: "docs/references.md lacks sandbox fail-closed marker (sandbox.failIfUnavailable)",
    });
  });

  test("a posture marker missing from the omca-setup skill fails", async () => {
    const ctx = fixture({ "skills/omca-setup/SKILL.md": without(VALID["skills/omca-setup/SKILL.md"], "allowManagedPermissionRulesOnly") });
    expect(await policy.run(ctx)).toEqual({
      status: "fail",
      detail: "skills/omca-setup/SKILL.md lacks managed settings boundary marker (allowManagedPermissionRulesOnly)",
    });
  });

  test("a doc with no statement that the permission filter does not auto-allow fails", async () => {
    const ctx = fixture({ "docs/references.md": without(VALID["docs/references.md"], "does not auto-allow") });
    expect(await policy.run(ctx)).toEqual({ status: "fail", detail: "docs/references.md lacks the non-bypassing permission filter guidance" });
  });

  test("each hook model marker is required in docs/references.md", async () => {
    const markers = ["hooks/register.ts", "mcp_tool", "omca_hook", "tool.check", "OMCA_DISABLED_HOOKS", "boulder.json", "verification-evidence.json"];
    for (const marker of markers) {
      const result = await policy.run(fixture({ "docs/references.md": without(VALID["docs/references.md"], marker) }));
      expect(result.status).toBe("fail");
      expect(result.detail).toContain(`(${marker})`);
    }
  });

  test("a missing doc fails", async () => {
    expect(await policy.run(fixture({ "skills/omca-setup/SKILL.md": null }))).toEqual({
      status: "fail",
      detail: "skills/omca-setup/SKILL.md is missing",
    });
  });
});
