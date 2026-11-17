import { Sequence, useVideoConfig } from "remotion";
import { fitWindow } from "../components/Camera.tsx";
import { type ClipManifest, mark } from "../footage.ts";
import { F3, F4, F6 } from "./clips.ts";
import { Canvas, establish, Shot, timeline, wide } from "./shot.tsx";

export type ColdOpenShot = { clip: ClipManifest; at: string; seconds: number; rotateY: number };

const CUT_BEFORE_MARK = 0.2;

export const SAMPLE_COLD_OPEN: readonly ColdOpenShot[] = [
  { clip: F3, at: "lanes", seconds: 1.3, rotateY: -7 },
  { clip: F4, at: "board", seconds: 1.4, rotateY: 7 },
  { clip: F6, at: "passed", seconds: 1.3, rotateY: -7 },
];

export const coldOpenPlan = (shots: readonly ColdOpenShot[], fps: number) => {
  let start = 0;
  const planned = shots.map((shot) => {
    const t = timeline(shot.clip, fps);
    const from = mark(shot.clip, shot.at) - t.seconds(CUT_BEFORE_MARK);
    t.play(from, from + t.seconds(shot.seconds));
    const at = start;
    start += t.duration;
    return { ...shot, start: at, t };
  });
  return { shots: planned, duration: start };
};

/** A montage of moving establish shots joined by hard cuts, with nothing to read. */
export const ColdOpen = ({ shots }: { shots: readonly ColdOpenShot[] }) => {
  const { fps, width, height } = useVideoConfig();
  const plan = coldOpenPlan(shots, fps);
  return (
    <Canvas>
      {plan.shots.map(({ clip, rotateY, start, t }) => {
        const lead = Math.round(t.duration / 2);
        return (
          <Sequence key={start} from={start} durationInFrames={t.duration} premountFor={fps}>
            <Shot
              clip={clip}
              box={fitWindow(clip, { width, height })}
              keyframes={establish(wide(clip), rotateY, -lead, t.duration + lead)}
              segments={t.segments}
            />
          </Sequence>
        );
      })}
    </Canvas>
  );
};
