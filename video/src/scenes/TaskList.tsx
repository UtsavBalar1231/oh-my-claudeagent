import { Sequence, useVideoConfig } from "remotion";
import { Caption } from "../components/Caption.tsx";
import { mark, shownTarget, target } from "../footage.ts";
import { toFrames } from "../theme.ts";
import { F4, F7 } from "./clips.ts";
import { aim, Canvas, PANE_COL, paneBox, paneScale, pushIn, SETTLE, Shot, stageFor, Timed, timeline } from "./shot.tsx";

const RUNNING_ROW = "running-row";
const ESTABLISH = 1.2;
const PUSH = 1;
// The board plays this long, then holds to BOARD_SECONDS; the light cut plays on from the same moment and holds to LIGHT_SECONDS.
const BOARD_PLAY = 5.5;
const BOARD_SECONDS = 7;
const LIGHT_SECONDS = 6;
// The pane opens this long into its establish, so the shot cuts in on the key press.
const OPENS = 0.7;
const CAPTION_TAIL = 0.3;
// The first hold frame of a shot, once its caption has faded in.
const CAPTION_IN = 0.3;

/** The Task list pane at the largest scale that fits a frame `height` high; the dark and light clips share the layout. */
const layout = (height: number) => {
  const stage = stageFor(height);
  const scale = paneScale(F4, stage);
  const box = paneBox(F4, scale, stage);
  const view = (clip: typeof F4) => aim(clip, box, { scale, top: 0, left: PANE_COL });
  return { box, board: view(F4), light: view(F7) };
};

export const taskListPlan = (fps: number, height: number) => {
  const f = (s: number) => toFrames(s, fps);
  const { box, board: boardView, light: lightView } = layout(height);
  const push = { from: f(ESTABLISH), to: f(ESTABLISH) + f(PUSH) };

  const board = timeline(F4, fps);
  const boardFrom = mark(F4, "board") - board.seconds(OPENS);
  const boardTo = boardFrom + board.seconds(BOARD_PLAY);
  shownTarget(F4, RUNNING_ROW, boardTo);
  board.play(boardFrom, boardTo);
  board.fill(boardTo, BOARD_SECONDS);

  const light = timeline(F7, fps);
  const lightFrom = boardTo + mark(F7, "board") - mark(F4, "board");
  const lightTo = target(F7, RUNNING_ROW).to - SETTLE;
  shownTarget(F7, RUNNING_ROW, lightTo);
  light.play(lightFrom, lightTo);
  light.fill(lightTo, LIGHT_SECONDS);

  return {
    box,
    board: { start: 0, duration: board.duration, segments: board.segments, keyframes: pushIn(boardView, 7, push, RUNNING_ROW), caption: { from: push.to, duration: board.duration - push.to } },
    light: {
      start: board.duration,
      duration: light.duration,
      segments: light.segments,
      keyframes: [{ ...lightView, frame: 0, target: RUNNING_ROW }],
      caption: { from: 0, duration: light.duration - f(CAPTION_TAIL) },
    },
    hold: push.to + f(CAPTION_IN),
    duration: board.duration + light.duration,
  };
};

/** The Task list pane, then a hard cut to the same list in the light theme. */
export const TaskList = () => {
  const { fps, height } = useVideoConfig();
  const plan = taskListPlan(fps, height);
  const shots = [
    { ...plan.board, clip: F4, text: "Every task, where it stands." },
    { ...plan.light, clip: F7, text: "It follows your theme." },
  ];
  return (
    <Canvas>
      {shots.map(({ start, duration, clip, segments, keyframes, caption, text }) => (
        <Sequence key={clip.scene} from={start} durationInFrames={duration} premountFor={fps}>
          <Shot clip={clip} box={plan.box} keyframes={keyframes} segments={segments} />
          <Timed {...caption}>
            <Caption text={text} />
          </Timed>
        </Sequence>
      ))}
    </Canvas>
  );
};
