import { useVideoConfig } from "remotion";
import { Callout } from "../components/Callout.tsx";
import { Caption } from "../components/Caption.tsx";
import { CornerLabel } from "../components/CornerLabel.tsx";
import { mark, shownTarget, target, targetRect } from "../footage.ts";
import { color, time, toFrames } from "../theme.ts";
import { F3 } from "./clips.ts";
import { aim, beatLength, Canvas, captionSpan, Chapter, PANE_COL, paneBox, paneCols, Shot, Timed, timeline } from "./shot.tsx";

const PANE = mark(F3, "pane");
const BOX = paneBox(F3);
const TOOL_ROW = shownTarget(F3, "tool-row", PANE);
const LANE_HEAD = target(F3, "lane-head");
const PUSH = 1.5;
// The beat opens on the whole pane at 1.0, then pushes in on the lanes: from the first lane's head
// row, as many columns as the window holds at 1.5, which still take in the live tool call.
const PANE_VIEW = aim(F3, BOX, { scale: 1, top: 0, left: PANE_COL });
const LANES_VIEW = aim(F3, BOX, { scale: PUSH, top: LANE_HEAD.row, left: PANE_COL });
if (PANE_COL + paneCols(F3) / PUSH < TOOL_ROW.col + TOOL_ROW.len) throw new Error("clip-delegate: the pushed-in lanes view would cut the live tool call");

export const agentsPlan = (fps: number) => {
  const f = (s: number) => toFrames(s, fps);
  const t = timeline(F3, fps);
  // The pane opens with its lanes; the hold covers the caption's reveal, the push and the callout.
  const held = t.hold(PANE, 4);
  const lanes = mark(F3, "lanes") + t.seconds(3);
  t.play(PANE, lanes);
  t.fill(lanes, beatLength(7));
  const move = { from: held.start + f(1.3), to: held.start + f(1.3) + f(time.camera) };
  return {
    t,
    move,
    callout: { from: move.to + f(0.1), duration: held.start + held.duration - move.to - f(0.2) },
    caption: captionSpan(t.duration, fps),
    duration: t.duration,
  };
};

export const Agents = () => {
  const { fps } = useVideoConfig();
  const plan = agentsPlan(fps);
  const keyframes = [
    { frame: 0, ...PANE_VIEW },
    { frame: plan.move.from, ...PANE_VIEW },
    { frame: plan.move.to, ...LANES_VIEW },
  ];
  return (
    <Canvas>
      <Shot clip={F3} border={color.omcaBorder} box={BOX} keyframes={keyframes} segments={plan.t.segments}>
        <Timed {...plan.callout}>
          <Callout target={targetRect(F3, TOOL_ROW)} label="Live tool call" side="right" />
        </Timed>
      </Shot>
      <CornerLabel />
      <Chapter name="Work" beatDuration={plan.duration} enters />
      <Timed {...plan.caption}>
        <Caption text="Each task goes to a specialist." />
      </Timed>
    </Canvas>
  );
};
