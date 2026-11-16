import { useVideoConfig } from "remotion";
import { Callout } from "../components/Callout.tsx";
import { Caption } from "../components/Caption.tsx";
import { CornerLabel } from "../components/CornerLabel.tsx";
import { mark, shownTarget, targetRect } from "../footage.ts";
import { color, toFrames } from "../theme.ts";
import { F6 } from "./clips.ts";
import { aim, beatLength, Canvas, captionSpan, PANE_COL, paneBox, Shot, Timed, timeline, TOP_BAR, Chapter } from "./shot.tsx";

// The final task's page in the Task list pane, from its first row.
const BOX = paneBox(F6);
const VIEW = aim(F6, BOX, { scale: 1, top: 0, left: PANE_COL });
const NO_VERDICT = mark(F6, "no-verdict");
const PASSED = mark(F6, "passed");

export const verifyPlan = (fps: number) => {
  const f = (s: number) => toFrames(s, fps);
  const t = timeline(F6, fps);
  const settled = PASSED + t.seconds(0.5);
  const waiting = t.hold(NO_VERDICT, 2.2);
  // The page reads the ledger as it opens, so the run reopens it once the verdict is logged; the cut
  // from the hold to the reopened page leaves out the list shown between them.
  t.play(PASSED, settled);
  const held = t.hold(settled, 2.6);
  t.fill(settled, beatLength(7));
  return {
    t,
    none: { from: waiting.start + f(0.4), duration: waiting.duration - f(0.5), row: shownTarget(F6, "no-verdict-row", NO_VERDICT) },
    passed: { from: held.start + f(0.1), duration: held.duration - f(0.1), row: shownTarget(F6, "passed-row", settled) },
    caption: captionSpan(t.duration, fps),
    duration: t.duration,
  };
};

export const Verify = () => {
  const { fps } = useVideoConfig();
  const { none, passed, ...plan } = verifyPlan(fps);
  return (
    <Canvas>
      <Shot clip={F6} border={color.omcaBorder} box={BOX} keyframes={[{ frame: 0, ...VIEW }]} segments={plan.t.segments}>
        <Timed from={none.from} duration={none.duration}>
          <Callout target={targetRect(F6, none.row)} label="No verdict yet" side={TOP_BAR} />
        </Timed>
        <Timed from={passed.from} duration={passed.duration}>
          <Callout target={targetRect(F6, passed.row)} label="Verdict: passed" side={TOP_BAR} />
        </Timed>
      </Shot>
      <CornerLabel />
      <Chapter name="Prove" beatDuration={plan.duration} enters />
      <Timed {...plan.caption}>
        <Caption text="Done means proven." />
      </Timed>
    </Canvas>
  );
};
