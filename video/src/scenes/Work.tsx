import { Sequence, useVideoConfig } from "remotion";
import { Caption } from "../components/Caption.tsx";
import { mark, shownTarget, target } from "../footage.ts";
import { toFrames } from "../theme.ts";
import { F3, F4, F7 } from "./clips.ts";
import { aim, Canvas, PANE_COL, paneBox, pushIn, SETTLE, Shot, Timed, timeline } from "./shot.tsx";

// The OMCA pane and the Task list pane, from their first row; the light clip shares the dark one's layout.
const LANES_BOX = paneBox(F3);
const LANES_VIEW = aim(F3, LANES_BOX, { scale: 1, top: 0, left: PANE_COL });
const BOARD_BOX = paneBox(F4);
const BOARD_VIEW = aim(F4, BOARD_BOX, { scale: 1, top: 0, left: PANE_COL });
const LIGHT_VIEW = aim(F7, BOARD_BOX, { scale: 1, top: 0, left: PANE_COL });
const LANE_HEAD = "lane-head";
const RUNNING_ROW = "running-row";
const ESTABLISH = 1.2;
const PUSH = 1;
const SHOT = 5;
const LIGHT = 4;
// Each pane opens this long into its establish, so the shot cuts in on the key press.
const OPENS = 0.7;
// Seconds before the beat ends, clear of the scene push into the next beat.
const CAPTION_TAIL = 0.3;

export const workPlan = (fps: number) => {
  const f = (s: number) => toFrames(s, fps);
  const push = { from: f(ESTABLISH), to: f(ESTABLISH) + f(PUSH) };

  const lanes = timeline(F3, fps);
  const lanesFrom = mark(F3, "lanes") - lanes.seconds(OPENS);
  const lanesTo = lanesFrom + lanes.seconds(SHOT);
  shownTarget(F3, LANE_HEAD, lanesTo);
  lanes.play(lanesFrom, lanesTo);

  // The dark board plays through the focus moving down a row; the light board picks up at the same
  // moment of its own run, so the hard cut changes only the theme.
  const board = timeline(F4, fps);
  const boardFrom = mark(F4, "board") - board.seconds(OPENS);
  const boardTo = boardFrom + board.seconds(SHOT);
  shownTarget(F4, RUNNING_ROW, boardTo);
  board.play(boardFrom, boardTo);

  const light = timeline(F7, fps);
  const lightFrom = boardTo + mark(F7, "board") - mark(F4, "board");
  const lightTo = target(F7, RUNNING_ROW).to - SETTLE;
  shownTarget(F7, RUNNING_ROW, lightTo);
  light.play(lightFrom, lightTo);
  light.fill(lightTo, LIGHT);

  const held = (duration: number) => ({ from: push.to, duration: duration - push.to });
  return {
    lanes: { start: 0, duration: lanes.duration, segments: lanes.segments, keyframes: pushIn(LANES_VIEW, -7, push, LANE_HEAD), caption: held(lanes.duration) },
    board: { start: lanes.duration, duration: board.duration, segments: board.segments, keyframes: pushIn(BOARD_VIEW, 7, push, RUNNING_ROW), caption: held(board.duration) },
    light: {
      start: lanes.duration + board.duration,
      duration: light.duration,
      segments: light.segments,
      keyframes: [{ ...LIGHT_VIEW, frame: 0, target: RUNNING_ROW }],
      caption: { from: 0, duration: light.duration - f(CAPTION_TAIL) },
    },
    duration: lanes.duration + board.duration + light.duration,
  };
};

/** Three executors in their lanes, then the Task list, then a hard cut to the same list in the light theme. */
export const Work = () => {
  const { fps } = useVideoConfig();
  const plan = workPlan(fps);
  const shots = [
    { ...plan.lanes, clip: F3, box: LANES_BOX, text: "One executor per task, in parallel." },
    { ...plan.board, clip: F4, box: BOARD_BOX, text: "Every task, where it stands." },
    { ...plan.light, clip: F7, box: BOARD_BOX, text: "It follows your theme." },
  ];
  return (
    <Canvas>
      {shots.map(({ start, duration, clip, box, segments, keyframes, caption, text }) => (
        <Sequence key={clip.scene} from={start} durationInFrames={duration} premountFor={fps}>
          <Shot clip={clip} box={box} keyframes={keyframes} segments={segments} />
          <Timed {...caption}>
            <Caption text={text} />
          </Timed>
        </Sequence>
      ))}
    </Canvas>
  );
};
