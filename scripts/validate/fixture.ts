import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Check, type Context, createContext, type Outcome } from "./core.ts";

export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const handler = (event: string) => ({
  type: "mcp_tool",
  server: "plugin:oh-my-claudeagent:omca",
  tool: "omca_hook",
  timeout: 10,
  input: { event },
});

const POSTURE = 'teammateMode: "auto"\nallowManagedPermissionRulesOnly\nsandbox.failIfUnavailable\nThe filter does not auto-allow anything.\n';
const HOOK_MODEL = "hooks/register.ts mcp_tool omca_hook tool.check OMCA_DISABLED_HOOKS boulder.json verification-evidence.json\n";

/** A tree in which every check passes; a spec changes one file and asserts the one check that reads it. */
export const VALID: Readonly<Record<string, string>> = {
  ".claude-plugin/plugin.json": json({ name: "oh-my-claudeagent", version: "1.2.3" }),
  ".claude-plugin/marketplace.json": json({
    name: "omca",
    metadata: { version: "1.2.3" },
    plugins: [{ name: "oh-my-claudeagent", version: "1.2.3", source: { source: "github", repo: "owner/repo" } }],
  }),
  "package.json": json({ name: "fixture", version: "1.2.3" }),
  ".mcp.json": json({ mcpServers: { omca: { command: "bun" } } }),
  "servers/categories.json": "{}\n",
  "hooks/hooks.json": json({
    modules: ["./register.ts"],
    hooks: {
      SessionStart: [{ matcher: "clear|compact", hooks: [handler("SessionStart")] }],
      Stop: [{ hooks: [handler("Stop")] }],
    },
  }),
  "agents/demo.md": "---\nname: demo\ndescription: d\nmodel: opus\neffort: high\ndisallowedTools:\n  - Agent\n---\nBody\n",
  "skills/demo/SKILL.md": "---\nname: demo\ndescription: d\ncontext: fork\nagent: demo\neffort: medium\n---\nBody\n",
  "docs/references.md": `${POSTURE}${HOOK_MODEL}`,
  "skills/omca-setup/SKILL.md": `---\nname: omca-setup\ndescription: d\n---\n${POSTURE}`,
  "README.md": "Run `just test`.\n",
  "CONTRIBUTING.md": "See `agents/demo.md`.\n",
  justfile: "default:\n\t@just --list\n\ntest:\n\ttrue\n",
  "servers/hooks/guidance.ts": 'const path = join(root, "templates", "claudemd.md");\n',
  "templates/claudemd.md": "# Template\n",
  "servers/hooks/registry.ts": 'import "./guidance.ts";\nimport { handle } from "./one.ts";\nexport const registry = [handle];\n',
  "servers/hooks/one.ts": "export const handle = 1;\n",
  "hooks/register.ts": 'on("session.start", hook);\non("tool.check", { tool: "Bash" }, hook);\n',
  "src/core/path.ts": "export const path = 1;\n",
  "tests/mod/a.test.ts": "export {};\n",
  "scripts/validate/allowlist.txt": "# no entries\n",
};

const made: string[] = [];

export function makeTree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "omca-validate-"));
  made.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

export function cleanup(): void {
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true });
}

/** A context over a temp tree: VALID with `patch` applied, where a null value removes the file. */
export function fixture(patch: Readonly<Record<string, string | null>> = {}, overrides: Partial<Context> = {}): Context {
  const files: Record<string, string> = { ...VALID };
  for (const [path, content] of Object.entries(patch)) {
    if (content === null) delete files[path];
    else files[path] = content;
  }
  return createContext(makeTree(files), { tracked: () => Object.keys(files), ...overrides });
}

export async function runNamed(checks: readonly Check[], name: string, ctx: Context): Promise<Outcome> {
  const check = checks.find((candidate) => candidate.name === name);
  if (check === undefined) throw new Error(`no check named ${name}`);
  return check.run(ctx);
}
