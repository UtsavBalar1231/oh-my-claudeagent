export type NextActionKind = "log-evidence" | "start-work" | "final-verification" | "review";

export type NextAction = { kind: NextActionKind; label: string; prompt: string };

export type ActionFacts = {
  plan: { name: string; path: string; done: number; total: number } | null;
  verification: { command: string; isLogged: boolean } | null;
  isAgentRunning: boolean;
  hasFinalVerification: boolean;
};

export const isPlanComplete = (plan: { done: number; total: number }): boolean =>
  plan.total > 0 && plan.done === plan.total;

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
  if (plan !== null && isPlanComplete(plan)) {
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

type LedgerEntry = { type?: unknown; exit_code?: unknown; plan_sha256?: unknown };

const entriesOf = (ledger: unknown): readonly LedgerEntry[] => {
  if (typeof ledger !== "object" || ledger === null || !("entries" in ledger)) return [];
  const { entries } = ledger;
  return Array.isArray(entries) ? entries.filter((entry) => typeof entry === "object" && entry !== null) : [];
};

/** The Stop gate's rule: exit 0, scoped to this plan's bytes or carrying no scope at all. */
export function hasPassingFinalVerification(ledger: unknown, planSha256: string): boolean {
  return entriesOf(ledger).some(
    (entry) =>
      entry.type === "final_verification" &&
      entry.exit_code === 0 &&
      (entry.plan_sha256 === undefined || entry.plan_sha256 === null || entry.plan_sha256 === "" || entry.plan_sha256 === planSha256),
  );
}
