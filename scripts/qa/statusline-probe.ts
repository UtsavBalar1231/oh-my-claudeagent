#!/usr/bin/env bun
// Pipes fixture payloads into both statusline renderers of a packaged copy of the plugin and
// asserts the markers they draw. No model session runs, so nothing here touches a config dir.
//
// Usage: bun scripts/qa/statusline-probe.ts
// Exit: 0 pass, 1 a check failed, 2 the run could not be set up.
import { join } from "node:path";
import { childEnv, runQa } from "./lib.ts";

const BASE = { model: { display_name: "claude-3-5-sonnet" }, context_window: { context_window_size: 200000, used_percentage: 10.0 }, cost: {} };

async function render(pluginDir: string, script: string, payload: unknown): Promise<string> {
  const proc = Bun.spawn(["bun", join(pluginDir, "statusline", script)], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv({ CLAUDE_STATUSLINE_NERD_FONT: "0" }),
  });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`statusline/${script} exited ${code}: ${stderr.trim()}`);
  return stdout;
}

if (import.meta.main) {
  await runQa(
    "statusline-probe",
    async ({ checks, scratch }) => {
      const pluginDir = scratch.plugin();

      const main = await render(pluginDir, "main.ts", { ...BASE, effort: { level: "high" }, thinking: { enabled: true } });
      checks.check(main.includes("E: high"), "main line: effort marker rendered (E: high)", `main line: effort marker missing from output: ${main}`);
      checks.check(!main.includes("[T]"), "main line: no thinking marker even with thinking on", `main line: thinking marker rendered: ${main}`);

      const bare = await render(pluginDir, "main.ts", BASE);
      checks.check(
        !bare.includes("E:"),
        "main line: no effort marker when the field is absent",
        `main line: effort marker rendered without the field: ${bare}`,
      );

      const task = { id: "t1", name: "oh-my-claudeagent:executor", status: "running", model: "sonnet", effort: "high" };
      const rows = (await render(pluginDir, "subagent.ts", { columns: 200, tasks: [task, { name: "no-id" }] }))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { id: string; content: string });
      checks.check(rows.length === 1 && rows[0]?.id === "t1", "subagent rows: one row, for the task that has an id", `subagent rows: expected one row for t1, got ${JSON.stringify(rows)}`);
      const content = rows[0]?.content ?? "";
      for (const marker of ["A: executor", "> Sonnet", "running", "E: high"]) {
        checks.check(content.includes(marker), `subagent row: ${marker} rendered`, `subagent row: ${marker} missing from ${JSON.stringify(content)}`);
      }
    },
    { watchRealConfig: false },
  );
}
