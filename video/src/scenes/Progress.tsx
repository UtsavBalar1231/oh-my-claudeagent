import { useVideoConfig } from "remotion";
import { Caption } from "../components/Caption.tsx";
import { CornerLabel } from "../components/CornerLabel.tsx";
import { mark, target } from "../footage.ts";
import { color } from "../theme.ts";
import { F8 } from "./clips.ts";
import { aim, beatLength, Canvas, captionSpan, cellBox, Chapter, Shot, Timed, timeline, TRANSCRIPT_COLS } from "./shot.tsx";

const BAND = target(F8, "band");
// From OMCA's band down to the row above the status line's cost row: the band, the prompt and the
// status line's first rows, the transcript's width, at 1.0.
const BAND_ROWS = target(F8, "cost-row").row - BAND.row;
const BOX = cellBox(F8, TRANSCRIPT_COLS, BAND_ROWS);
const VIEW = aim(F8, BOX, { scale: 1, top: BAND.row, left: 0 });

export const progressPlan = (fps: number) => {
  const t = timeline(F8, fps);
  // From the band's first frame through /omca typed in the prompt; the pane it opens and the slash
  // menu above the band stay out of the window.
  const end = mark(F8, "cmd-typed") + t.seconds(1);
  t.play(BAND.from, end);
  t.fill(end, beatLength(6));
  return { t, caption: captionSpan(t.duration, fps), duration: t.duration };
};

export const Progress = () => {
  const { fps } = useVideoConfig();
  const plan = progressPlan(fps);
  return (
    <Canvas>
      <Shot clip={F8} border={color.omcaBorder} box={BOX} keyframes={[{ frame: 0, ...VIEW }]} segments={plan.t.segments} />
      <CornerLabel />
      <Chapter name="Work" beatDuration={plan.duration} leaves />
      <Timed {...plan.caption}>
        <Caption text="Progress where you type." />
      </Timed>
    </Canvas>
  );
};
