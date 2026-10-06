import type { ReactNode } from "react";
import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { wipe } from "@remotion/transitions/wipe";
import { AbsoluteFill, interpolate, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { Camera } from "../components/Camera.tsx";
import { CornerLabel } from "../components/CornerLabel.tsx";
import { type ClipManifest, mark, target, type Rect } from "../footage.ts";
import { color, ease, mono, SAFE, toFrames, VIDEO } from "../theme.ts";
import { F1, F2, F3, F4, F5, F6, F7, F8 } from "./clips.ts";
import { aim, PANE_COL, paneCols, TRANSCRIPT_COLS } from "./shot.tsx";

// The room for a sizzle window: the top band holds the mark and the corner label.
const AREA: Rect = { x: SAFE.x, y: 106, width: VIDEO.width - 2 * SAFE.x, height: VIDEO.height - 106 - SAFE.top };
const PUNCH = { from: 1.05, frames: 6 };
// Clip frames between a cut and its action's mark. A mark lands 0 to 4 frames after its state
// paints, so a lead of 5 opens every cut before the change; at 2x the change lands 1 to 5 frames in.
const LEAD = 5;
// Footage text is read at no more than 1.5 footage pixels per composition pixel and no less than
// 17 composition pixels per cell.
const MAX_SCALE = 1.5;
const MIN_CELL = 17;

// A window of whole cells: `cols` columns from column `left` and `rows` rows from row `top`, at
// `scale`, or at the largest scale that fits the area. Without `rows`, as many rows as fit.
type Framing = { top: number; left: number; cols: number; rows?: number; scale?: number };

type Cut = {
  id: string;
  clip: ClipManifest;
  seconds: number;
  framing: Framing;
  /** The clip frame of the action the cut lands on. */
  at: number;
  rate: number;
  /** Clip frames before the action's mark; defaults to LEAD. */
  lead?: number;
  /** A second clip the cut wipes to, at the same framing and footage frame. */
  wipeTo?: ClipManifest;
};

/** The window, the view and the on-screen cell width for a cut; every window edge sits on a cell boundary. */
const frame = (cut: Cut) => {
  const { clip, framing } = cut;
  const { width: cw, height: ch } = clip.cell;
  const scale = framing.scale ?? Math.min(MAX_SCALE, AREA.width / (framing.cols * cw), framing.rows === undefined ? MAX_SCALE : AREA.height / (framing.rows * ch));
  const rows = framing.rows ?? Math.floor(AREA.height / (ch * scale));
  const width = framing.cols * cw * scale;
  const height = rows * ch * scale;
  if (width > AREA.width + 0.5 || height > AREA.height + 0.5) throw new Error(`${cut.id}: ${framing.cols}x${rows} cells at ${scale} overflow the area`);
  if (scale > MAX_SCALE || cw * scale < MIN_CELL) throw new Error(`${cut.id}: a cell is ${(cw * scale).toFixed(1)} px at scale ${scale.toFixed(3)}`);
  const box = { x: AREA.x + (AREA.width - width) / 2, y: AREA.y + (AREA.height - height) / 2, width, height };
  return { box, rows, cell: cw * scale, view: aim(clip, box, { scale, top: framing.top, left: framing.left }) };
};

const PANE = (clip: ClipManifest, top = 0): Framing => ({ top, left: PANE_COL, cols: paneCols(clip) });

const laneHead = target(F3, "lane-head");
const proven = target(F4, "proven-chip");
const discard = target(F5, "discard-lines");
const claimLine = target(F1, "claim-line");
const stopLine = target(F1, "stop-line");
const notepadCard = target(F8, "notepad-card");
const statsHeader = target(F8, "stats-header");
const band = target(F8, "band");
const costRow = target(F8, "cost-row");
const question = target(F2, "question");
const verdict = target(F6, "verdict-line");
// The board's task list ends two cells after its proof chips, at the divider before the task detail.
const LIST_COLS = proven.col + proven.len + 2 - PANE_COL;
// A mark lands up to four frames after its state paints, so the focus cut ends six clip frames
// before the task-open mark and the task's detail never shows.
const S3 = { seconds: 0.8, rate: 2 };
const S3_LEAD = mark(F4, "focus-moved") - (mark(F4, "task-open") - 6 - S3.seconds * F4.fps * S3.rate);

// Lengths speed up from 0.9 s to 0.45 s; framings alternate whole pane, tight and medium.
const CUTS: readonly Cut[] = [
  // The pane has painted at its mark, so the first frame is a finished, readable composition.
  { id: "S1 pane opens", clip: F3, seconds: 0.9, framing: PANE(F3), at: mark(F3, "pane"), rate: 2, lead: 0 },
  // Below the tab bar, the lanes from their minis to the end of the first lane's head row.
  { id: "S2 lanes", clip: F3, seconds: 0.8, framing: { top: laneHead.row, left: PANE_COL, cols: laneHead.col + laneHead.len - PANE_COL }, at: mark(F3, "lanes") + 30, rate: 4 },
  { id: "S3 focus moves", clip: F4, seconds: S3.seconds, framing: { top: proven.row - 2, left: PANE_COL, cols: LIST_COLS, scale: 1.2 }, at: mark(F4, "focus-moved"), rate: S3.rate, lead: S3_LEAD },
  // The board has painted at its mark.
  { id: "S4 proof chips", clip: F4, seconds: 0.7, framing: { top: proven.row - 2, left: PANE_COL, cols: LIST_COLS }, at: mark(F4, "board"), rate: 2, lead: 0 },
  // The whole terminal width: the 96-column captures wrap every line inside it.
  { id: "S5 guard dialog", clip: F5, seconds: 0.7, framing: { top: discard.row - 11, left: 0, cols: F5.grid.cols }, at: mark(F5, "dialog"), rate: 2 },
  // From the claim to the row under the Stop hook's feedback, as wide as the feedback wraps. The
  // claim has painted at its mark, and the feedback lands two clip frames later.
  {
    id: "S6 stop feedback",
    clip: F1,
    seconds: 0.6,
    framing: { top: claimLine.row, left: 0, cols: stopLine.col + stopLine.len + 1, rows: stopLine.row + stopLine.rows + 1 - claimLine.row },
    at: mark(F1, "claim-done"),
    rate: 2,
    lead: 0,
  },
  { id: "S7 theme wipe", clip: F4, seconds: 0.6, framing: PANE(F4), at: mark(F4, "board") + 30, rate: 1, wipeTo: F7 },
  // The tabs have painted at their marks, so the previous tab never shows.
  { id: "S8 notepad", clip: F8, seconds: 0.5, framing: { top: notepadCard.row, left: PANE_COL, cols: notepadCard.col + notepadCard.len - PANE_COL }, at: mark(F8, "notepad-tab"), rate: 2, lead: 0 },
  { id: "S9 stats", clip: F8, seconds: 0.5, framing: PANE(F8, statsHeader.row - 3), at: mark(F8, "stats-tab"), rate: 2, lead: 0 },
  // The band down to the row above the cost row, while /omca is typed in the prompt.
  { id: "S10 band", clip: F8, seconds: 0.5, framing: { top: band.row, left: 0, cols: TRANSCRIPT_COLS, rows: costRow.row - band.row }, at: mark(F8, "cmd-typed"), rate: 2, lead: 15 },
  { id: "S11 tab key", clip: F8, seconds: 0.45, framing: PANE(F8), at: mark(F8, "plan-tab"), rate: 2 },
  { id: "S12 interview", clip: F2, seconds: 0.45, framing: { top: question.row - 4, left: 0, cols: Math.floor(AREA.width / (F2.cell.width * MAX_SCALE)) }, at: mark(F2, "dialog"), rate: 2, lead: 3 },
  // MISSING reads for 0.3 s before it turns COMPLETE, then the card holds to the cut to black.
  { id: "S13 verdict", clip: F6, seconds: 1, framing: PANE(F6), at: mark(F6, "complete"), rate: 1, lead: 9 },
];

const S13 = frame({ id: "S13", clip: F6, seconds: 1, framing: PANE(F6), at: 0, rate: 1 });
if (verdict.row >= S13.rows) throw new Error("clip-verify: the verdict line falls below the S13 window");

/** Each cut's start, length and footage range in composition frames. */
export const sizzleTimeline = (fps: number) => {
  let start = 0;
  return CUTS.map((cut) => {
    const duration = toFrames(cut.seconds, fps);
    const trimBefore = markFrameAt(cut.clip, cut.at - (cut.lead ?? LEAD), fps);
    const end = trimBefore + duration * cut.rate;
    if (trimBefore < 0 || end > Math.round((cut.clip.frames * fps) / cut.clip.fps)) throw new Error(`${cut.id}: ${cut.clip.scene} has no footage for this cut`);
    const placed = { cut, start, duration, trimBefore, end, cell: frame(cut).cell };
    start += duration;
    return placed;
  });
};

const markFrameAt = (clip: ClipManifest, at: number, fps: number) => Math.round((at * fps) / clip.fps);

export const sizzlePlan = (fps: number) => ({ duration: sizzleTimeline(fps).reduce((sum, c) => sum + c.duration, 0) });

const Punch = ({ box, children }: { box: Rect; children: ReactNode }) => {
  const f = useCurrentFrame();
  const scale = interpolate(f, [0, PUNCH.frames], [PUNCH.from, 1], { extrapolateRight: "clamp", easing: ease.entrance });
  return <AbsoluteFill style={{ scale: `${scale}`, transformOrigin: `${box.x + box.width / 2}px ${box.y + box.height / 2}px` }}>{children}</AbsoluteFill>;
};

const WIPE = { at: 2, frames: 12 };

const CutShot = ({ cut, duration, trimBefore, punch }: { cut: Cut; duration: number; trimBefore: number; punch: boolean }) => {
  const { fps } = useVideoConfig();
  const { box, view } = frame(cut);
  const camera = (clip: ClipManifest, length: number, from: number) => (
    <Camera
      src={`footage/${clip.scene}.mp4`}
      footage={clip}
      keyframes={[{ frame: 0, ...view }]}
      durationInFrames={length}
      trimBefore={from}
      playbackRate={cut.rate}
      box={box}
      border={color.omcaBorder}
    />
  );
  if (cut.wipeTo === undefined) return punch ? <Punch box={box}>{camera(cut.clip, duration, trimBefore)}</Punch> : camera(cut.clip, duration, trimBefore);
  const dark = WIPE.at + WIPE.frames;
  const light = duration - WIPE.at;
  const lightFrom = markFrameAt(cut.wipeTo, Math.round(((trimBefore + WIPE.at * cut.rate) * cut.clip.fps) / fps), fps);
  return (
    <Punch box={box}>
      <TransitionSeries>
        <TransitionSeries.Sequence durationInFrames={dark} premountFor={fps}>
          {camera(cut.clip, dark, trimBefore)}
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={wipe({ direction: "from-right" })} timing={linearTiming({ durationInFrames: WIPE.frames, easing: ease.camera })} />
        <TransitionSeries.Sequence durationInFrames={light} premountFor={fps}>
          {camera(cut.wipeTo, light, lightFrom)}
        </TransitionSeries.Sequence>
      </TransitionSeries>
    </Punch>
  );
};

const Mark = () => (
  <div style={{ position: "absolute", left: SAFE.x, top: SAFE.top, fontFamily: mono, fontSize: 28, lineHeight: "30px", letterSpacing: "0.02em", color: color.muted }}>
    oh-my-claudeagent
  </div>
);

// Thirteen hard cuts, each after the first opening on a 6-frame zoom punch; frame 0 is a finished
// composition, the frame the end card dissolves into.
export const Sizzle = () => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: color.canvas }}>
      {sizzleTimeline(fps).map(({ cut, start, duration, trimBefore }, i) => (
        <Sequence key={cut.id} from={start} durationInFrames={duration} premountFor={fps}>
          <CutShot cut={cut} duration={duration} trimBefore={trimBefore} punch={i > 0} />
        </Sequence>
      ))}
      <Mark />
      <CornerLabel />
    </AbsoluteFill>
  );
};
