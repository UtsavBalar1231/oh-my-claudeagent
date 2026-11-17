import { useVideoConfig } from "remotion";
import { Caption } from "../components/Caption.tsx";
import { mark, shownTarget, target } from "../footage.ts";
import { toFrames } from "../theme.ts";
import { F6 } from "./clips.ts";
import { aim, Canvas, PANE_COL, paneBox, pushIn, SETTLE, Shot, Timed, timeline } from "./shot.tsx";

// The final task's page in the Task list pane, from its first row.
const BOX = paneBox(F6);
const VIEW = aim(F6, BOX, { scale: 1, top: 0, left: PANE_COL });
const NO_VERDICT_ROW = "no-verdict-row";
const PASSED_ROW = "passed-row";
const ESTABLISH = 1.6;
const PUSH = 1.2;
const NO_VERDICT_HOLD = 2.4;
// The page opens this long into the establish, so the shot cuts in on the key press.
const OPENS = 0.8;
const SECONDS = 10;

export const provePlan = (fps: number) => {
  const f = (s: number) => toFrames(s, fps);
  const push = { from: f(ESTABLISH), to: f(ESTABLISH) + f(PUSH) };
  const end = f(SECONDS);
  const t = timeline(F6, fps);

  const from = mark(F6, "no-verdict") - t.seconds(OPENS);
  const asked = from + t.seconds(ESTABLISH + PUSH + NO_VERDICT_HOLD);
  shownTarget(F6, NO_VERDICT_ROW, asked);
  const before = t.play(from, asked);
  // The page reads the ledger as it opens, so the run reopens it once the verdict is logged; the cut
  // lands on the reopened page in the same framing and leaves out the run between them.
  const passedTo = target(F6, PASSED_ROW).to - SETTLE;
  shownTarget(F6, PASSED_ROW, passedTo);
  const after = t.play(mark(F6, "passed"), passedTo);
  t.fill(passedTo, SECONDS);

  return {
    t,
    keyframes: [...pushIn(VIEW, -7, push, NO_VERDICT_ROW), { ...VIEW, frame: after.start, target: PASSED_ROW }],
    captions: {
      before: { from: push.to, duration: before.duration - push.to },
      after: { from: after.start, duration: end - after.start },
    },
    duration: end,
  };
};

/** The final task's page shows no verdict, then the same page after the run logs one. */
export const Prove = () => {
  const { fps } = useVideoConfig();
  const plan = provePlan(fps);
  return (
    <Canvas>
      <Shot clip={F6} box={BOX} keyframes={plan.keyframes} segments={plan.t.segments} />
      <Timed {...plan.captions.before}>
        <Caption text="The last task waits for proof." />
      </Timed>
      <Timed {...plan.captions.after}>
        <Caption text="Done means proven." />
      </Timed>
    </Canvas>
  );
};
