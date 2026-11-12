import { isOlder, parseVersion } from "../src/core/doctor-checks.ts";
import { isHookDisabled } from "../src/core/kill-switch.ts";
import { agentsDoneText, type Member, outcomeOf } from "../src/core/notify.ts";
import { glyphs } from "../src/core/ui-kit.ts";
import type { Features } from "./dispatch.ts";
import { type Host, reason, sessionOf } from "./host.ts";

const TITLE = "OMCA";
const KEY = "agents-done";
const HOLD_MS = 60_000;
const KEYED_FROM = "2.1.321";

type Entry = Omit<Member, "outcome"> & { outcome: Member["outcome"] | undefined };

// The wave is a module value: a render reads no atom for it, so a change redraws nothing.
const wave = new Map<string, Entry>();

// Clients before 2.1.321 send the title alone: `key`, `delayMs` and `untilBack` are theirs from that release.
async function isKeyed(host: Host): Promise<boolean> {
  try {
    const version = parseVersion((await host.session.version()).version);
    return version !== undefined && !isOlder(version, KEYED_FROM);
  } catch (error) {
    host.log(`notify: cannot read the client version: ${reason(error)}`);
    return false;
  }
}

async function cancelHeld(host: Host): Promise<void> {
  if (!(await isKeyed(host))) return;
  try {
    await host.ui.cancelNotify(KEY);
  } catch (error) {
    host.log(`notify: cannot cancel the held notification: ${reason(error)}`);
  }
}

async function send(host: Host, members: readonly Member[]): Promise<void> {
  const text = agentsDoneText(members, glyphs((await sessionOf(host)).glyphTier));
  const options = (await isKeyed(host)) ? { title: TITLE, key: KEY, delayMs: HOLD_MS, untilBack: true } : { title: TITLE };
  try {
    await host.ui.notify(text, options);
  } catch (error) {
    host.log(`notify: cannot send the notification: ${reason(error)}`);
  }
}

export const notify: Features = {
  "agent.spawn": {
    async post(host, e, result) {
      if (result.deny !== undefined || result.agentId === undefined || e.isTeammate === true) return undefined;
      if (isHookDisabled((await sessionOf(host)).disabledHooks, "notify")) return undefined;
      const isNewWave = wave.size === 0;
      wave.set(result.agentId, { type: e.subagentType, description: e.description, outcome: undefined });
      if (isNewWave) await cancelHeld(host);
      return undefined;
    },
  },
  "turn.complete": {
    async post(host, e) {
      const member = e.agentId === undefined ? undefined : wave.get(e.agentId);
      if (e.agentId === undefined || member === undefined || member.outcome !== undefined) return undefined;
      wave.set(e.agentId, { ...member, outcome: outcomeOf(e.reason) });
      const ended: [string, Entry][] = [...wave];
      const members = ended.flatMap(([, entry]) => (entry.outcome === undefined ? [] : [{ ...entry, outcome: entry.outcome }]));
      if (members.length < ended.length) return undefined;
      try {
        await send(host, members);
      } finally {
        for (const [id, entry] of ended) if (wave.get(id) === entry) wave.delete(id);
      }
      return undefined;
    },
  },
};
