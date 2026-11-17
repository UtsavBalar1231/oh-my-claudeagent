import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { wipe } from "@remotion/transitions/wipe";
import { useVideoConfig } from "remotion";
import { Caption } from "../components/Caption.tsx";
import { mark } from "../footage.ts";
import { ease, toFrames } from "../theme.ts";
import { F4, F7 } from "./clips.ts";
import { aim, beatLength, Canvas, crossfadeFrames, PANE_COL, paneBox, Shot, Timed, timeline } from "./shot.tsx";

// The Task list pane from its first row; the light clip shares the layout.
const BOX = paneBox(F4);
const BOARD_VIEW = aim(F4, BOX, { scale: 1, top: 0, left: PANE_COL });
const LIGHT_VIEW = aim(F7, BOX, { scale: 1, top: 0, left: PANE_COL });
const LOOK = 1.2;
const WIPE = 0.5;
const LENGTH = beatLength(7);

export const boardPlan = (fps: number) => {
  const f = (s: number) => toFrames(s, fps);
  const edge = crossfadeFrames(fps);
  const dark = timeline(F4, fps);
  const board = mark(F4, "board");
  const look = board + dark.seconds(LOOK);
  const open = mark(F4, "task-open");
  dark.play(board, look);
  dark.hold(look, 2);
  // The list does not change until the focus moves, so the cut from the hold lands 0.3 s before the move.
  dark.play(mark(F4, "focus-moved") - dark.seconds(0.3), open + dark.seconds(1));
  const wipeFrames = f(WIPE);
  const light = timeline(F7, fps);
  const lightBoard = mark(F7, "board");
  light.play(lightBoard, lightBoard + light.seconds(1.5));
  light.fill(lightBoard + light.seconds(1.5), LENGTH - dark.duration / fps + WIPE);
  return {
    dark,
    light,
    wipe: wipeFrames,
    list: { from: edge + f(0.1), duration: dark.duration - edge - f(0.1) - wipeFrames },
    theme: { from: dark.duration, duration: light.duration - wipeFrames - edge },
    duration: dark.duration + light.duration - wipeFrames,
  };
};

export const Board = () => {
  const { fps } = useVideoConfig();
  const plan = boardPlan(fps);
  return (
    <Canvas>
      <TransitionSeries>
        <TransitionSeries.Sequence durationInFrames={plan.dark.duration} premountFor={fps}>
          <Canvas>
            <Shot clip={F4} box={BOX} keyframes={[{ frame: 0, ...BOARD_VIEW }]} segments={plan.dark.segments} />
          </Canvas>
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={wipe({ direction: "from-right" })} timing={linearTiming({ durationInFrames: plan.wipe, easing: ease.camera })} />
        <TransitionSeries.Sequence durationInFrames={plan.light.duration} premountFor={fps}>
          <Canvas>
            <Shot clip={F7} box={BOX} keyframes={[{ frame: 0, ...LIGHT_VIEW }]} segments={plan.light.segments} />
          </Canvas>
        </TransitionSeries.Sequence>
      </TransitionSeries>
      <Timed {...plan.list}>
        <Caption text="Every task, where it stands." />
      </Timed>
      <Timed {...plan.theme}>
        <Caption text="It follows your theme." />
      </Timed>
    </Canvas>
  );
};
