import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Callout } from "./components/Callout.tsx";
import { mark, shownTarget, targetRect, type Rect } from "./footage.ts";
import { color } from "./theme.ts";
import { F6 } from "./scenes/clips.ts";
import { aim, Canvas, PANE_COL, Shot, Timed, timeline } from "./scenes/shot.tsx";

export const LOOP = { width: 800, height: 450, fps: 15 } as const;

const NO_VERDICT = mark(F6, "no-verdict");
const PASSED = mark(F6, "passed");
// The crop holds the final task's page from the pane's edge, across the loop's full width: 40 columns
// take the snippet under the verdict ("13 of 14 tasks done; 42 tests passed"), and rows 1 to 8 hold
// the title, its state, the verdict and the first link. The band under the window holds the callout's label.
const COLS = { from: PANE_COL, to: PANE_COL + 40 };
const ROWS = { from: 1, count: 8 };
const SCALE = LOOP.width / ((COLS.to - COLS.from) * F6.cell.width);
const INSET = 16;
const BOX: Rect = { x: 0, y: INSET, width: LOOP.width, height: Math.round(ROWS.count * F6.cell.height * SCALE) };
const VIEW = aim(F6, BOX, { scale: SCALE, top: ROWS.from, left: COLS.from });
const DIM_PEAK = 0.75;

export const loopPlan = (fps: number) => {
  const t = timeline(F6, fps);
  const settled = PASSED + t.seconds(3.2);
  const row = shownTarget(F6, "passed-row", settled);
  if (row.row < ROWS.from || row.row >= ROWS.from + ROWS.count || row.col + row.len > COLS.to) throw new Error("clip-verify: the verdict row falls outside the loop's crop");
  t.hold(NO_VERDICT, 3);
  t.play(PASSED, settled);
  const held = t.hold(settled, 5);
  // The dim-through switches back to the no-verdict frame at its midpoint, so the last frame is a
  // dimmed no-verdict frame that leads into frame 0 without repeating it.
  const out = t.hold(settled, 0.35);
  t.hold(NO_VERDICT, 0.35);
  return { t, row, callout: { from: held.start, duration: held.duration }, dim: { from: out.start, duration: t.duration - out.start }, duration: t.duration };
};

const DimThrough = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const opacity = interpolate(frame, [0, durationInFrames / 2, durationInFrames], [0, DIM_PEAK, 0]);
  return <div style={{ position: "absolute", inset: 0, background: color.canvas, opacity }} />;
};

export const Loop = () => {
  const { fps } = useVideoConfig();
  const plan = loopPlan(fps);
  return (
    <Canvas>
      <Shot clip={F6} keyframes={[{ frame: 0, ...VIEW }]} segments={plan.t.segments} box={BOX}>
        <Timed {...plan.callout}>
          <Callout target={targetRect(F6, plan.row)} label="Verdict: passed" side={{ bottom: 30 }} />
        </Timed>
      </Shot>
      <Timed {...plan.dim}>
        <DimThrough />
      </Timed>
    </Canvas>
  );
};
