import type { CommandRunResult } from "claude-code";
import type { Features, Input } from "./dispatch.ts";
import type { Host } from "./host.ts";
import * as pane from "./pane.ts";
import * as doctor from "./tabs/doctor.ts";
import * as plan from "./tabs/plan.ts";
import * as stats from "./tabs/stats.ts";

export type Subcommand = (
  host: Host,
  e: Input<"command.run">,
  args: string,
) => CommandRunResult | undefined | Promise<CommandRunResult | undefined>;

export const USAGE = "Usage: /omca [plan [name|path]|stats|doctor]";

const SUBCOMMANDS = new Map<string, Subcommand>([
  ["", pane.command],
  ["plan", plan.command],
  ["stats", stats.command],
  ["doctor", doctor.command],
]);

export function split(args: string): { name: string; rest: string } {
  const match = /^(\S*)\s*(.*)$/s.exec(args.trim());
  return { name: match?.[1] ?? "", rest: match?.[2] ?? "" };
}

export const router: Features = {
  "command.run": {
    async pre(host, e) {
      const { name, rest } = split(e.args);
      const subcommand = SUBCOMMANDS.get(name);
      if (subcommand === undefined) return { answer: { text: `Unknown /omca subcommand "${name}". ${USAGE}` } };
      const answer = await subcommand(host, e, rest);
      return answer === undefined ? undefined : { answer };
    },
  },
};
