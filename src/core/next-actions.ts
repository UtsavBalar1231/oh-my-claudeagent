import { allTasksDone } from "./checkboxes.ts";
import { evidenceOf, provesPlan } from "./evidence.ts";

export type NextActionKind = "log-evidence" | "start-work" | "final-verification" | "review";

export type NextAction = { kind: NextActionKind; label: string; prompt: string };

export type ActionFacts = {
  plan: { name: string; path: string; done: number; total: number } | null;
  verification: { command: string; isLogged: boolean } | null;
  isAgentRunning: boolean;
  hasFinalVerification: boolean;
};

export function nextActions({ plan, verification, isAgentRunning, hasFinalVerification }: ActionFacts): NextAction[] {
  const actions: NextAction[] = [];
  if (verification !== null && !verification.isLogged) {
    actions.push({
      kind: "log-evidence",
      label: "Log evidence",
      prompt: `Log evidence for \`${verification.command}\` with evidence_log`,
    });
  }
  if (plan !== null && plan.done < plan.total && !isAgentRunning) {
    actions.push({ kind: "start-work", label: "Start work", prompt: `/oh-my-claudeagent:start-work ${plan.path}` });
  }
  if (plan !== null && allTasksDone(plan)) {
    actions.push(
      hasFinalVerification
        ? { kind: "review", label: "Review with oracle", prompt: `Review the changes made for ${plan.name} with oracle` }
        : {
            kind: "final-verification",
            label: "Run final verification",
            prompt: `Run the final verification for ${plan.name}`,
          },
    );
  }
  return actions;
}

/** The Stop gate's rule over parsed ledger data: any readable entry proves this plan's bytes. */
export function hasPassingFinalVerification(ledger: unknown, planSha256: string): boolean {
  return evidenceOf(ledger).some((entry) => provesPlan(entry, planSha256));
}
