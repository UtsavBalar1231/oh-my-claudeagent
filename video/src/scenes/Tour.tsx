import type { FC } from "react";
import { useVideoConfig } from "remotion";
import { Caption } from "../components/Caption.tsx";
import { CornerLabel } from "../components/CornerLabel.tsx";
import { mark } from "../footage.ts";
import { color } from "../theme.ts";
import { F8 } from "./clips.ts";
import { aim, beatLength, Canvas, captionSpan, PANE_COL, paneBox, Chapter, Shot, Timed, timeline } from "./shot.tsx";

// One beat per tab of the /omca pane, from its first row. Each plays its tab from the key press (plus
// `after` seconds) to the frame before the next tab's key, or `until` a later mark, then holds.
const BOX = paneBox(F8);
const VIEW = aim(F8, BOX, { scale: 1, top: 0, left: PANE_COL });

type TabSpec = {
  tab: string;
  after?: number;
  until: { mark: string; seconds: number };
  span: number;
  caption: string;
  chapter: { name: string; enters?: boolean; leaves?: boolean };
};

const tabBeat = ({ tab, after = 0, until, span, caption, chapter }: TabSpec): { Scene: FC; plan: (fps: number) => { duration: number } } => {
  const plan = (fps: number) => {
    const t = timeline(F8, fps);
    const end = mark(F8, until.mark) + t.seconds(until.seconds);
    t.play(mark(F8, tab) + t.seconds(after), end);
    t.fill(end, beatLength(span));
    return { t, caption: captionSpan(t.duration, fps), duration: t.duration };
  };
  const Scene = () => {
    const { fps } = useVideoConfig();
    const p = plan(fps);
    return (
      <Canvas>
        <Shot clip={F8} border={color.omcaBorder} box={BOX} keyframes={[{ frame: 0, ...VIEW }]} segments={p.t.segments} />
        <CornerLabel />
        <Chapter name={chapter.name} beatDuration={p.duration} enters={chapter.enters ?? false} leaves={chapter.leaves ?? false} />
        <Timed {...p.caption}>
          <Caption text={caption} />
        </Timed>
      </Canvas>
    );
  };
  return { Scene, plan };
};

// A mark lands 0 to 4 frames after its state paints, so the next tab can already show four frames
// before its mark; each beat ends five frames before it.
const LAST_FRAME_BEFORE = -5 / F8.fps;
export const Ledger = tabBeat({ tab: "evidence-tab", after: 0.5, until: { mark: "notepad-tab", seconds: LAST_FRAME_BEFORE }, span: 4, caption: "Every run, by day.", chapter: { name: "Prove", leaves: true } });
export const Notepad = tabBeat({ tab: "notepad-tab", until: { mark: "stats-tab", seconds: LAST_FRAME_BEFORE }, span: 4, caption: "Notes that outlive compaction.", chapter: { name: "See it all", enters: true } });
export const Stats = tabBeat({ tab: "stats-tab", until: { mark: "stats-tab", seconds: 1 }, span: 4, caption: "What each agent cost.", chapter: { name: "See it all", leaves: true } });
