export type NextActionKind = "log-evidence";

export type NextAction = { kind: NextActionKind; label: string; prompt: string };

export type ActionFacts = { verification: { command: string; isLogged: boolean } | null };

export function nextActions({ verification }: ActionFacts): NextAction[] {
  if (verification === null || verification.isLogged) return [];
  return [{ kind: "log-evidence", label: "Log evidence", prompt: `Log evidence for \`${verification.command}\` with evidence_log` }];
}
