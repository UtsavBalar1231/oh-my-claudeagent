import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { MAX_SCALE } from "./components/Camera.tsx";
import { mark, shownTarget, type Rect } from "./footage.ts";
import { color } from "./theme.ts";
import { F6 } from "./scenes/clips.ts";
import { aim, Canvas, PANE_COL, Shot, Timed, timeline } from "./scenes/shot.tsx";

export const LOOP = { width: 800, height: 450, fps: 15 } as const;

const NO_VERDICT = mark(F6, "no-verdict");
const PASSED = mark(F6, "passed");
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
const DIM_PEAK = 0.75;

export const loopPlan = (fps: number) => {
  const t = timeline(F6, fps);
  const settled = PASSED + t.seconds(3.2);
  const row = shownTarget(F6, "passed-row", settled);
  if (row.row < ROWS.from || row.row >= ROWS.from + ROWS.count || row.col + row.len > COLS.to) throw new Error("clip-verify: the verdict row falls outside the loop's crop");
  t.hold(NO_VERDICT, 3);
  t.play(PASSED, settled);
  t.hold(settled, 5);
  // The dim-through switches back to the no-verdict frame at its midpoint, so the last frame is a
  // dimmed no-verdict frame that leads into frame 0 without repeating it.
  const out = t.hold(settled, 0.35);
  t.hold(NO_VERDICT, 0.35);
  return { t, dim: { from: out.start, duration: t.duration - out.start }, duration: t.duration };
};

const DimThrough = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const opacity = interpolate(frame, [0, durationInFrames / 2, durationInFrames], [0, DIM_PEAK, 0]);
  return <div style={{ position: "absolute", inset: 0, background: color.stage, opacity }} />;
};

export const Loop = () => {
  const { fps } = useVideoConfig();
  const plan = loopPlan(fps);
  return (
    <Canvas>
      <Shot clip={F6} keyframes={[{ frame: 0, ...VIEW }]} segments={plan.t.segments} box={BOX} />
      <Timed {...plan.dim}>
        <DimThrough />
      </Timed>
    </Canvas>
  );
};
