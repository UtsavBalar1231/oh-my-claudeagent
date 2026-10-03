import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fixture, json, runNamed } from "./fixture.ts";
import { checks } from "./manifest.ts";

afterEach(cleanup);

const marketplace = (plugin: Record<string, unknown>, metadata: Record<string, unknown> = { version: "1.2.3" }) =>
  json({ name: "omca", metadata, plugins: [{ name: "oh-my-claudeagent", version: "1.2.3", ...plugin }] });

describe("manifest checks", () => {
  test("every check passes on a consistent tree, skipping only the source check that has no path source to read", async () => {
    const ctx = fixture();
    for (const check of checks) {
      const expected = check.name === "marketplace source" ? "skip" : "pass";
      expect(await check.run(ctx)).toMatchObject({ status: expected });
    }
  });

  test("marketplace source: a tree with no string source skips and names why", async () => {
    expect(await runNamed(checks, "marketplace source", fixture())).toEqual({
      status: "skip",
      detail: "no marketplace plugin has a path source, only a github or other object source",
    });
  });

  test("json valid: a file that does not parse fails and is named", async () => {
    const result = await runNamed(checks, "json valid", fixture({ "hooks/hooks.json": "{not json" }));
    expect(result.status).toBe("fail");
    expect(result.detail.startsWith("hooks/hooks.json: ")).toBe(true);
  });

  test("json valid: a missing file fails and is named", async () => {
    const result = await runNamed(checks, "json valid", fixture({ "servers/categories.json": null }));
    expect(result.status).toBe("fail");
    expect(result.detail.startsWith("servers/categories.json: ")).toBe(true);
  });

  test("plugin name: another name fails", async () => {
    const ctx = fixture({ ".claude-plugin/plugin.json": json({ name: "other", version: "1.2.3" }) });
    expect(await runNamed(checks, "plugin name", ctx)).toEqual({ status: "fail", detail: 'plugin.json name is "other"' });
  });

  test("marketplace entry: a marketplace without the plugin fails", async () => {
    const ctx = fixture({ ".claude-plugin/marketplace.json": json({ plugins: [{ name: "other" }] }) });
    expect(await runNamed(checks, "marketplace entry", ctx)).toEqual({ status: "fail", detail: "no plugin named oh-my-claudeagent" });
  });

  test("marketplace source: a path source outside the plugin fails", async () => {
    const ctx = fixture({ ".claude-plugin/marketplace.json": marketplace({ source: "../elsewhere" }) });
    expect(await runNamed(checks, "marketplace source", ctx)).toEqual({
      status: "fail",
      detail: "oh-my-claudeagent source '../elsewhere' is not a ./ path",
    });
  });

  test("marketplace source: a bare dot passes by default and fails under a marketplace override", async () => {
    const files = { ".claude-plugin/marketplace.json": marketplace({ source: "." }) };
    expect(await runNamed(checks, "marketplace source", fixture(files))).toMatchObject({ status: "pass" });
    expect(await runNamed(checks, "marketplace source", fixture(files, { marketplaceOverride: true }))).toMatchObject({ status: "fail" });
  });

  describe("versions equal", () => {
    test("a different plugin.json version fails against the other three", async () => {
      const ctx = fixture({ ".claude-plugin/plugin.json": json({ name: "oh-my-claudeagent", version: "1.2.4" }) });
      expect(await runNamed(checks, "versions equal", ctx)).toEqual({
        status: "fail",
        detail: [
          'marketplace.json metadata.version is "1.2.3", plugin.json says "1.2.4"',
          'marketplace.json plugins[0].version is "1.2.3", plugin.json says "1.2.4"',
          'package.json version is "1.2.3", plugin.json says "1.2.4"',
        ].join("; "),
      });
    });

    test("each marketplace field is compared on its own", async () => {
      const metadataOnly = fixture({ ".claude-plugin/marketplace.json": marketplace({}, { version: "9.9.9" }) });
      expect(await runNamed(checks, "versions equal", metadataOnly)).toEqual({
        status: "fail",
        detail: 'marketplace.json metadata.version is "9.9.9", plugin.json says "1.2.3"',
      });
      const pluginOnly = fixture({ ".claude-plugin/marketplace.json": marketplace({ version: "9.9.9" }) });
      expect(await runNamed(checks, "versions equal", pluginOnly)).toEqual({
        status: "fail",
        detail: 'marketplace.json plugins[0].version is "9.9.9", plugin.json says "1.2.3"',
      });
    });

    test("a package.json version that differs fails", async () => {
      const ctx = fixture({ "package.json": json({ version: "0.0.1" }) });
      expect(await runNamed(checks, "versions equal", ctx)).toEqual({
        status: "fail",
        detail: 'package.json version is "0.0.1", plugin.json says "1.2.3"',
      });
    });

    test("build metadata is semver, and an empty one is not", async () => {
      const at = (version: string) =>
        fixture({
          ".claude-plugin/plugin.json": json({ name: "oh-my-claudeagent", version }),
          ".claude-plugin/marketplace.json": marketplace({ version }, { version }),
          "package.json": json({ version }),
        });
      expect(await runNamed(checks, "versions equal", at("1.2.3+build"))).toMatchObject({ status: "pass" });
      expect(await runNamed(checks, "versions equal", at("1.2.3+"))).toEqual({ status: "fail", detail: 'plugin.json version "1.2.3+" is not semver' });
    });

    test("a plugin.json version that is not semver fails even when all four agree", async () => {
      const ctx = fixture({
        ".claude-plugin/plugin.json": json({ name: "oh-my-claudeagent", version: "next" }),
        ".claude-plugin/marketplace.json": marketplace({ version: "next" }, { version: "next" }),
        "package.json": json({ version: "next" }),
      });
      expect(await runNamed(checks, "versions equal", ctx)).toEqual({ status: "fail", detail: 'plugin.json version "next" is not semver' });
    });
  });
});
