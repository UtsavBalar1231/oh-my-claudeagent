import { readFileSync, statSync } from "node:fs";
import { isHookDisabled } from "../../src/core/kill-switch.ts";
import { isPlanPath } from "../../src/core/plan-path.ts";
import { inputText } from "../../src/core/tool-input.ts";
import type { Handler } from "./registry.ts";

// Keeps the warning short on a plan with many malformed boxes while still naming the usual single typo.
const MAX_NAMED_LINES = 5;

export const handle: Handler = (payload) => {
  if ((payload.tool_name !== "Write" && payload.tool_name !== "Edit") || isHookDisabled(process.env.OMCA_DISABLED_HOOKS, "plan-format-warn")) return;
  const filePath = inputText(payload.tool_input, "file_path");
  if (!isPlanPath(filePath) || statSync(filePath, { throwIfNoEntry: false })?.isFile() !== true) return;
  const malformed = readFileSync(filePath, "utf8")
    .split("\n")
    .flatMap((line, index) => (line.startsWith("- [ ] ") && !/^- \[ \] \d+\./.test(line) ? [`${index + 1}:${line}`] : []));
  if (malformed.length === 0) return;
  const lines = [
    `[PLAN-FORMAT-WARN] ${filePath} has ${malformed.length} checkbox line(s) that will not be counted as numbered tasks:`,
    ...malformed.slice(0, MAX_NAMED_LINES),
    ...(malformed.length > MAX_NAMED_LINES ? [`...and ${malformed.length - MAX_NAMED_LINES} more`] : []),
    "Fix: a - [ ] line not matching '- [ ] N.' will not be counted; use the numbered form.",
  ];
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: lines.join("\n") } };
};
