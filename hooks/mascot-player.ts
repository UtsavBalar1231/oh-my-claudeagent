import type { Timer } from "claude-code";
import type { Lane } from "../src/core/mission.ts";
import { FRAME_MS, framesOf, MINI, type MascotName, type MascotSize, type MascotState, mascotOf, rasterCells, SIZE } from "../src/core/mascots.ts";
import { type Host, reason } from "./host.ts";
import { PANE } from "./pane.ts";

let timer: Timer | undefined;
let isBlitting = false;
let isStill = false;
let counter = 0;
// The agents whose mascots the latest drawing laid out, at the size it drew each, so the timer blits only those.
let drawn: ReadonlyMap<string, MascotSize> = new Map();

/** The frame every working mascot is at: a drawing made now lands where the blits are. */
export const frame = (): number => counter;

export const still = (): boolean => isStill;

export const keyOf = (id: string): string => `mascot-${id}`;

export function stateOf({ endedAt, status }: Pick<Lane, "endedAt" | "status">): MascotState {
  if (endedAt === null) return status === "running" ? "working" : "idle";
  return status === "answer" ? "done" : "failed";
}

export function show(shown: Iterable<readonly [id: string, size: MascotSize]>): void {
  drawn = new Map(shown);
}

async function working(host: Host): Promise<{ id: string; name: MascotName; size: MascotSize }[]> {
  const [pane, agents, surfaces] = await Promise.all([host.state.pane.get(), host.state.agents.get(), host.session.surfaces()]);
  if (pane.value?.tab !== "agents" || !surfaces.includes("terminal")) return [];
  return Object.entries(agents.value ?? {}).flatMap(([id, row]) => {
    const name = mascotOf(row.type);
    const size = drawn.get(id);
    return name === undefined || size === undefined || stateOf(row) !== "working" ? [] : [{ id, name, size }];
  });
}

async function advance(host: Host): Promise<void> {
  const shown = await working(host);
  if (shown.length === 0) {
    stop();
    // A state write may have drawn the still frame just before this tick's blit landed; one more
    // drawing makes the still frame the last one.
    host.ui.invalidate();
    return;
  }
  counter += 1;
  await Promise.all(
    shown.map(({ id, name, size }) => {
      const frames = framesOf(name, "working", size);
      const next = frames[counter % frames.length];
      const grid = size === "mini" ? MINI : SIZE;
      return next === undefined ? undefined : host.ui.blit({ requestId: PANE, key: keyOf(id), columns: grid, rows: grid / 2, cells: rasterCells(next) });
    }),
  );
}

/** Starts the timer when a shown agent works on a terminal; a blit the engine denies is a mascot that is not mounted. The setting is read here, never in a render. */
export async function ensure(host: Host): Promise<void> {
  const wasStill = isStill;
  try {
    isStill = (await host.settings.read())["prefersReducedMotion"] === true;
  } catch (error) {
    host.log(`omca mascots could not read prefersReducedMotion: ${reason(error)}`);
  }
  if (isStill !== wasStill) host.ui.invalidate();
  if (isStill) {
    stop();
    return;
  }
  if (timer !== undefined || (await working(host)).length === 0) return;
  timer ??= host.clock.every(FRAME_MS, async () => {
    if (isBlitting) return;
    isBlitting = true;
    try {
      await advance(host);
    } catch (error) {
      host.log(`omca mascots could not blit: ${reason(error)}`);
    } finally {
      isBlitting = false;
    }
  });
}

export function stop(): void {
  timer?.cancel();
  timer = undefined;
  counter = 0;
  drawn = new Map();
}
