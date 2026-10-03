import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Callout } from "./components/Callout.tsx";
import { mark, shownTarget, target, targetRect, type Rect } from "./footage.ts";
import { color } from "./theme.ts";
import { F6 } from "./scenes/clips.ts";
import { aim, Canvas, PANE_COL, Shot, Timed, timeline } from "./scenes/shot.tsx";

export const LOOP = { width: 800, height: 450, fps: 15 } as const;

const CHIP = shownTarget(F6, "complete-chip", mark(F6, "complete"));
// The crop holds the verdict card's words, not its box: from the Evidence pane's edge to the cell
// after the verdict line ends, across the loop's full width; rows 1 to 8 hold the card and the
// ledger's first day. The band under the window holds the callout's label.
const VERDICT = target(F6, "verdict-line");
const COLS = { from: PANE_COL, to: VERDICT.col + VERDICT.len + 1 };
const ROWS = { from: 1, count: 8 };
const SCALE = LOOP.width / ((COLS.to - COLS.from) * F6.cell.width);
const INSET = 16;
const BOX: Rect = { x: 0, y: INSET, width: LOOP.width, height: Math.round(ROWS.count * F6.cell.height * SCALE) };
const VIEW = aim(F6, BOX, { scale: SCALE, top: ROWS.from, left: COLS.from });
const DIM_PEAK = 0.75;

export const loopPlan = (fps: number) => {
  const t = timeline(F6, fps);
  const missing = mark(F6, "evidence-logged") - 1;
  const settled = mark(F6, "complete") + t.seconds(3.2);
  t.hold(missing, 3);
  t.play(missing, settled);
  const held = t.hold(settled, 5);
  // The dim-through switches back to the MISSING frame at its midpoint, so the last frame is a
  // dimmed MISSING frame that leads into frame 0 without repeating it.
  const out = t.hold(settled, 0.35);
  t.hold(missing, 0.35);
  return { t, callout: { from: held.start, duration: held.duration }, dim: { from: out.start, duration: t.duration - out.start }, duration: t.duration };
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
          <Callout target={targetRect(F6, CHIP)} label="Verdict: COMPLETE" side={{ bottom: 30 }} />
        </Timed>
      </Shot>
      <Timed {...plan.dim}>
        <DimThrough />
      </Timed>
    </Canvas>
  );
};
