import { Sequence, useVideoConfig } from "remotion";
import { Caption } from "./components/Caption.tsx";
import { MAX_SCALE } from "./components/Camera.tsx";
import { mark, shownTarget, type Rect } from "./footage.ts";
import { F6 } from "./scenes/clips.ts";
import { GuardPair, guardPairPlan, SAMPLE_PAIR } from "./scenes/GuardPair.tsx";
import { aim, Canvas, PANE_COL, Shot, timeline } from "./scenes/shot.tsx";

export const LOOP = { width: 800, height: 450, fps: 15 } as const;

/** `fps` and `proveHold` (seconds) are the two things the README WebP gives up when it is over budget. */
export type LoopProps = { fps: number; proveHold: number };
export const LOOP_PROPS: LoopProps = { fps: LOOP.fps, proveHold: 3 };

const PASSED = mark(F6, "passed");
const PASSED_ROW = "passed-row";
const PROVE_PLAY = 1;
// At 450 px high the scaled captions come out at 9 to 12 px, too small to read in the README.
const CAPTION_SIZE = 20;
// The crop holds the final task's page from the pane's edge: 40 columns take the snippet under the
// verdict ("13 of 14 tasks done; 42 tests passed"), and rows 1 to 8 hold the title, its state, the
// verdict and the first link. At the camera's scale ceiling the 40 columns are narrower than the
// loop, so the box is centered.
const COLS = { from: PANE_COL, to: PANE_COL + 40 };
const ROWS = { from: 1, count: 8 };
const SCALE = Math.min(MAX_SCALE, LOOP.width / ((COLS.to - COLS.from) * F6.cell.width));
const INSET = 16;
const WIDTH = Math.round((COLS.to - COLS.from) * F6.cell.width * SCALE);
const BOX: Rect = { x: Math.round((LOOP.width - WIDTH) / 2), y: INSET, width: WIDTH, height: Math.round(ROWS.count * F6.cell.height * SCALE) };
const VIEW = aim(F6, BOX, { scale: SCALE, top: ROWS.from, left: COLS.from });

export const loopPlan = (fps: number, proveHold: number) => {
  const guard = guardPairPlan(fps, SAMPLE_PAIR, LOOP.height);
  const t = timeline(F6, fps);
  const settled = PASSED + t.seconds(PROVE_PLAY);
  const row = shownTarget(F6, PASSED_ROW, settled);
  if (row.row < ROWS.from || row.row >= ROWS.from + ROWS.count || row.col + row.len > COLS.to) throw new Error("clip-verify: the verdict row falls outside the loop's crop");
  t.play(PASSED, settled);
  t.hold(settled, proveHold);
  return { guard, prove: { start: guard.duration, t, duration: t.duration }, duration: guard.duration + t.duration };
};

/** The Guard pair, then the Prove hold on the passed row. */
export const Loop = ({ proveHold }: LoopProps) => {
  const { fps } = useVideoConfig();
  const plan = loopPlan(fps, proveHold);
  return (
    <Canvas>
      <Sequence durationInFrames={plan.guard.duration} premountFor={fps}>
        <GuardPair captionSize={CAPTION_SIZE} />
      </Sequence>
      <Sequence from={plan.prove.start} durationInFrames={plan.prove.duration} premountFor={fps}>
        <Shot clip={F6} keyframes={[{ frame: 0, ...VIEW, target: PASSED_ROW }]} segments={plan.prove.t.segments} box={BOX} />
        <Caption text="Done means proven." size={CAPTION_SIZE} />
      </Sequence>
    </Canvas>
  );
};
