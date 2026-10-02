import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isTrustedTooling } from "./trusted-tooling.ts";

const FIXTURES = join(import.meta.dir, "..", "..", "tests", "fixtures", "hooks");
const fixtureCommand = (name: string): string =>
  (JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as { tool_input: { command: string } }).tool_input.command;

const allowed = (command: string) => expect(isTrustedTooling(command)).toBe(true);
const declined = (command: string) => expect(isTrustedTooling(command)).toBe(false);

test("permission-filter: npm run build is allowed", () => allowed("npm run build"));
test("permission-filter: npm install falls through (no auto-allow)", () => declined("npm install express"));
test("permission-filter: uv run is allowed", () => allowed("uv run --project servers ruff check servers/"));
test("permission-filter: jq is allowed", () => allowed("jq . file.json"));

test("permission-filter: && compound falls through", () => declined("jq . a.json && cat b.json"));
test("permission-filter: || compound falls through", () => declined("jq . a.json || cat b.json"));
test("permission-filter: semicolon compound falls through", () => declined("jq . a.json; cat b.json"));
test("permission-filter: pipeline falls through", () => declined("jq . a.json | sh"));
test("permission-filter: backtick substitution falls through", () => declined("jq . `cat name`"));
test("permission-filter: dollar-paren substitution falls through", () => declined("jq . $(cat name)"));
test("permission-filter: output redirect falls through", () => declined("jq . a.json > /tmp/out"));
test("permission-filter: append redirect falls through", () => declined("npm test >> /tmp/log"));
test("permission-filter: input redirect falls through", () => declined("jq . < a.json"));
test("permission-filter: stderr redirect falls through", () => declined("uv run pytest 2> /tmp/err"));
test("permission-filter: merged redirect falls through", () => declined("uv sync &> /tmp/err"));
test("permission-filter: background separator falls through", () => declined("jq . a.json & cat b.json"));
test("permission-filter: newline separator falls through", () => declined("jq . a.json\ncat b.json"));
test("permission-filter: jq whose single-quoted filter contains a pipe defers to the platform", () =>
  declined("jq -r '.a | .b' f.json"));
test("permission-filter: jq with a quoted separator is not auto-allowed", () => declined('jq -r ".a | .b" f.json'));

test("if Bash(npm *): npm test is allowed", () => allowed(fixtureCommand("permissionrequest-npm-test.json")));
test("if Bash(npm *): npm run build is allowed", () => allowed("npm run build"));
test("if Bash(npm *): npm run test is allowed", () => allowed("npm run test"));
test("if Bash(npm *): npm ci is allowed", () => allowed("npm ci"));
test("if Bash(npm *): npm list is allowed", () => allowed("npm list"));
test("if Bash(npm *): npm view react is allowed", () => allowed("npm view react"));
test("if Bash(npm *): npm install <pkg> falls through (no decision)", () => declined("npm install express"));
test("if Bash(npm *): npm install (bare) falls through (no decision)", () => declined("npm install"));
test("if Bash(npm *): npm i falls through (no decision)", () => declined("npm i lodash"));
test("if Bash(npm *): npm publish falls through (no decision)", () => declined("npm publish"));
test("if Bash(npm *): npm exec falls through (no decision)", () => declined("npm exec some-tool"));

test("if Bash(jq *): jq query is allowed", () => allowed(fixtureCommand("permissionrequest-jq.json")));
test("if Bash(jq *): jq -r is allowed", () => allowed("jq -r .name package.json"));
test("if Bash(jq *): jq --rawfile produces no decision (falls through)", () =>
  declined("jq --rawfile data file.txt . input.json"));

test("if Bash(uv *): uv run python script.py is allowed", () => allowed(fixtureCommand("permissionrequest-uv.json")));
test("if Bash(uv *): uv run --project servers ruff check is allowed", () =>
  allowed("uv run --project servers ruff check servers/"));
test("if Bash(uv *): uv sync is allowed", () => allowed("uv sync"));
test("if Bash(uv *): uv sync --frozen is allowed", () => allowed("uv sync --frozen"));

test("if Bash(bun *): bun run build is allowed", () => allowed("bun run build"));
test("if Bash(bun *): bun test is allowed", () => allowed("bun test"));
test("if Bash(bun *): bun ci is allowed", () => allowed("bun ci"));
test("if Bash(bun *): bun install <package> falls through (no decision)", () => declined("bun install some-package"));
test("if Bash(bun *): bun install (bare) falls through (no decision)", () => declined("bun install"));
test("if Bash(yarn *): yarn run build is allowed", () => allowed("yarn run build"));
test("if Bash(yarn *): yarn test is allowed", () => allowed("yarn test"));
test("if Bash(yarn *): yarn ci is allowed", () => allowed("yarn ci"));
test("if Bash(yarn *): yarn install falls through (no decision)", () => declined("yarn install"));
test("if Bash(yarn *): yarn add <package> falls through (no decision)", () => declined("yarn add lodash"));
test("if Bash(pnpm *): pnpm run test is allowed", () => allowed("pnpm run test"));
test("if Bash(pnpm *): pnpm test is allowed", () => allowed("pnpm test"));
test("if Bash(pnpm *): pnpm ci is allowed", () => allowed("pnpm ci"));
test("if Bash(pnpm *): pnpm install falls through (no decision)", () => declined("pnpm install"));
test("if Bash(pnpm *): pnpm add <package> falls through (no decision)", () => declined("pnpm add express"));

test("leading blanks are trimmed and a trailing newline is dropped, as the 2.x sed and $() did", () => {
  allowed("   npm test");
  allowed("npm test\n");
  declined("npm test\nrm -rf x");
});

test("a lookalike tool name, an uv subcommand off the list, or a bare manager is declined", () => {
  declined("npmx test");
  declined("jqx .");
  declined("uv pip install x");
  declined("npm");
  declined("npm testing");
});
