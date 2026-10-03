import { isSafeId } from "../src/core/session-id.ts";
import { glyphs } from "../src/core/ui-kit.ts";
import type { Features } from "./dispatch.ts";
import { type Host, reason, sessionOf } from "./host.ts";

export type Verdict = "up" | "down";
export type Rating = { turn_id: string | null; at: string; rating: Verdict; note?: string };

export const USAGE = "Usage: /omca-rate up|down [note]";

const SELECTED_NOTE_LIMIT = 200;

let lastTurnId: string | null = null;
let ratings: readonly Rating[] = [];
let failure: string | null = null;

export const shown = (): { ratings: readonly Rating[]; error: string | null; hasTurn: boolean } => ({
  ratings,
  error: failure,
  hasTurn: lastTurnId !== null,
});

function isRating(value: unknown): value is Rating {
  if (typeof value !== "object" || value === null) return false;
  const { turn_id: turnId, at, rating, note } = value as Record<string, unknown>;
  return (
    (turnId === null || typeof turnId === "string") &&
    typeof at === "string" &&
    (rating === "up" || rating === "down") &&
    (note === undefined || typeof note === "string")
  );
}

async function fileOf(host: Host): Promise<{ sessionId: string; path: string }> {
  const [root, sessionId] = await Promise.all([host.session.root(), host.session.id()]);
  if (!isSafeId(sessionId)) throw new Error(`the session id "${sessionId}" cannot name a file`);
  return { sessionId, path: `${root}/.omca/feedback/${sessionId}.json` };
}

async function load(host: Host, path: string): Promise<unknown[]> {
  if (!(await host.fs.exists(path))) return [];
  const data: unknown = JSON.parse(await host.fs.read(path));
  const entries = typeof data === "object" && data !== null && "ratings" in data ? data.ratings : undefined;
  if (!Array.isArray(entries)) throw new Error("it holds no ratings list");
  return entries;
}

async function selectedNote(host: Host): Promise<string> {
  const words = ((await host.ui.selection())?.text ?? "").trim().replace(/\s+/g, " ");
  const { ellipsis } = glyphs((await sessionOf(host)).glyphTier);
  const letters = [...words];
  return letters.length > SELECTED_NOTE_LIMIT ? `${letters.slice(0, SELECTED_NOTE_LIMIT - [...ellipsis].length).join("")}${ellipsis}` : words;
}

export async function rate(host: Host, verdict: Verdict, note: string, fromSelection = false): Promise<string> {
  try {
    const { sessionId, path } = await fileOf(host);
    const entries = await load(host, path);
    const at = new Date(await host.clock.now()).toISOString();
    const rating: Rating = { turn_id: lastTurnId, at, rating: verdict, ...(note === "" ? {} : { note }) };
    await host.fs.write(path, `${JSON.stringify({ session_id: sessionId, ratings: [...entries, rating] }, null, 2)}\n`);
    ratings = [...entries.filter(isRating), rating];
    failure = null;
    const subject = lastTurnId === null ? "the session (no turn yet)" : "the last turn";
    const source = fromSelection ? " with the selected text as the note" : "";
    return `Rated ${subject} ${verdict}${source}${note === "" ? "" : `: "${note}"`}.`;
  } catch (error) {
    failure = `Could not record the rating: ${reason(error)}`;
    return failure;
  }
}

export const feedback: Features = {
  "session.start": {
    async post(host) {
      lastTurnId = null;
      await host.command.register({
        name: "omca-rate",
        description: "Rate the last OMCA turn up or down, with an optional note",
        argumentHint: "up|down [note]",
        immediate: true,
      });
      try {
        ratings = (await load(host, (await fileOf(host)).path)).filter(isRating);
        failure = null;
      } catch (error) {
        ratings = [];
        failure = `Could not read this session's feedback: ${reason(error)}`;
      }
      return undefined;
    },
  },
  "turn.complete": {
    post(_host, e) {
      if (e.agentId === undefined) lastTurnId = e.turnId;
      return undefined;
    },
  },
  "command.run": {
    async pre(host, e) {
      const match = /^(up|down)(?:\s+(.*))?$/s.exec(e.args.trim());
      const verdict = match?.[1];
      if (verdict !== "up" && verdict !== "down") return { answer: { text: USAGE } };
      const typed = (match?.[2] ?? "").trim();
      const selected = typed === "" ? await selectedNote(host) : "";
      return { answer: { text: await rate(host, verdict, typed === "" ? selected : typed, selected !== "") } };
    },
  },
};
