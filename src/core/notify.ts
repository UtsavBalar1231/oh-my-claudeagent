import { fitEnd, type Glyphs, oneLine, shortType } from "./ui-kit.ts";

export type Outcome = "finished" | "failed" | "stopped";
export type Member = { type: string; description: string; outcome: Outcome };

const MAX_CELLS = 199;

const OUTCOME: Readonly<Record<string, Outcome>> = { answer: "finished", aborted: "stopped" };

/** A refusal and an API error both count as failed. */
export const outcomeOf = (reason: string): Outcome => OUTCOME[reason] ?? "failed";

/** The one-line text of the wave's closing notification; `members` are in spawn order. */
export function agentsDoneText(members: readonly Member[], g: Pick<Glyphs, "dot" | "ellipsis">): string {
  const [only] = members;
  if (only === undefined) return "";
  const types = members.map((member) => shortType(member.type)).join(", ");
  const count = (outcome: Outcome) => members.filter((member) => member.outcome === outcome).length;
  const failed = count("failed");
  const stopped = count("stopped");
  const lead =
    members.length === 1
      ? `${shortType(only.type)} ${only.outcome}`
      : failed + stopped === 0
        ? `${members.length} agents finished`
        : `${members.length} agents done${failed > 0 ? `, ${failed} failed` : ""}${stopped > 0 ? `, ${stopped} stopped` : ""}`;
  const tail = members.length === 1 ? oneLine(only.description) : types;
  return fitEnd(tail === "" ? lead : `${lead} ${g.dot} ${tail}`, MAX_CELLS, g.ellipsis);
}
