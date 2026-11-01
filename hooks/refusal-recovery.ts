import { isHookDisabled } from "../src/core/kill-switch.ts";
import type { Features, Input } from "./dispatch.ts";
import { reason } from "./host.ts";

// Only the reasoning-extraction refusal is followed up, with the request its own guidance gives:
// conclusions, evidence and actions in place of reasoning. Usage-policy refusals such as cyber
// are left to the person, who can rewind, rephrase or report a false positive with /feedback.
const FOLLOW_UP =
  "The previous turn ended with a reasoning-extraction refusal. Inspect the current state before continuing the existing permissible coding task with normal coding tools. Give concise conclusions, observable evidence and actions taken, not private reasoning. Do not repeat actions or claim progress without checking.";

type Origin = { user: boolean; input?: Input<"prompt.submit"> };
type Pending = { id: string; queued: boolean; cancel: () => void };
let interactive = false;
let arrivals: Origin[] = [];
let current: { id: string; user: boolean; generation: number } | undefined;
let pending: Pending | undefined;
let generation = 0;
let competingStarts = 0;
let attempted: string | undefined;

function clearPending(): void {
  if (pending !== undefined && !pending.queued) {
    pending.cancel();
    pending = undefined;
  }
}

export const refusalRecovery: Features = {
  "session.start": {
    pre(_host, e) {
      pending?.cancel();
      pending = undefined;
      interactive = e.isInteractive;
      arrivals = [];
      current = undefined;
      generation = 0;
      competingStarts = 0;
      attempted = undefined;
    },
  },
  "prompt.submit": {
    pre(_host, e) {
      const user = e.origin.kind === "composer" || e.origin.kind === "bridge";
      if (user) {
        // Once queued, the engine may start either turn first; neither can safely inherit user provenance.
        if (pending?.queued) competingStarts = 2;
        generation++;
        clearPending();
      }
      if (!e.isMeta) arrivals.push({ user: user && e.command === undefined, input: e });
    },
    post(_host, e, result) {
      if ("drop" in result) {
        const at = arrivals.findIndex((arrival) => arrival.input === e);
        if (at !== -1) arrivals.splice(at, 1);
      }
    },
  },
  "prompt.edit": {
    pre(_host, e) {
      if (e.start === e.end && e.inputText === "") return;
      generation++;
      clearPending();
    },
  },
  "turn.start": {
    pre(_host, e) {
      if (e.agentId !== undefined) return;
      const next = arrivals.shift();
      const contested = competingStarts > 0;
      if (contested) competingStarts--;
      current = { id: e.turnId, user: !contested && e.text !== "" && next?.user === true && next.input?.text === e.text, generation };
      if (pending?.queued && ((!contested && next !== undefined && next.input === undefined) || (contested && competingStarts === 0))) pending = undefined;
      if (pending?.id !== e.turnId) clearPending();
    },
  },
  "turn.complete": {
    async post(host, e) {
      if (!interactive || e.agentId !== undefined || e.reason !== "refusal" || e.refusal.category !== "reasoning_extraction") return;
      if (isHookDisabled(await host.env.OMCA_DISABLED_HOOKS(), "refusal-recovery")) return;
      if (!current?.user || current.id !== e.turnId || current.generation !== generation || pending || attempted === e.turnId) return;
      const text = FOLLOW_UP;
      attempted = e.turnId;
      const at = generation;
      let attempt: Pending;
      const timer = host.clock.after(0, async () => {
        if (pending !== attempt || at !== generation || current?.id !== e.turnId) return;
        attempt.queued = true;
        // The engine skips this plugin's prompt.submit hook for its own submitted prompt.
        const followUp: Origin = { user: false };
        arrivals.push(followUp);
        try {
          const submitted = await host.prompt.submit({ text });
          if ("drop" in submitted) {
            arrivals = arrivals.filter((arrival) => arrival !== followUp);
            if (pending === attempt) pending = undefined;
            competingStarts = 0;
            host.log(`refusal recovery dropped: ${submitted.drop}`);
            host.ui.toast("OMCA could not start the refusal follow-up; the original refusal remains.");
          }
        } catch (error) {
          arrivals = arrivals.filter((arrival) => arrival !== followUp);
          if (pending === attempt) pending = undefined;
          competingStarts = 0;
          host.log(`refusal recovery rejected: ${reason(error)}`);
          host.ui.toast("OMCA could not start the refusal follow-up; the original refusal remains.");
        }
      });
      attempt = { id: e.turnId, queued: false, cancel: () => timer.cancel() };
      pending = attempt;
    },
  },
};
