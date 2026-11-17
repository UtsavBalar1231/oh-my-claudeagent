import { useVideoConfig } from "remotion";
import { Caption } from "../components/Caption.tsx";
import { mark, shownTarget, target } from "../footage.ts";
import { toFrames } from "../theme.ts";
import { F8 } from "./clips.ts";
import { aim, Canvas, cellBox, crossfadeFrames, PANE_COL, paneCols, pushIn, SETTLE, Shot, Timed, timeline } from "./shot.tsx";

// The /omca pane from its tab row through row 21, where the Stats page's last box closes, at the
// legibility floor (36 px cells at 1080p): 21 rows fill the stage's height, and the 18-row pane
// window at 1.0 would cut the Evidence tab's detail box and the Stats page's boxes.
const SCALE = 36 / F8.cell.height;
const ROWS = { from: 1, count: 21 };
const BOX = cellBox(F8, paneCols(F8), ROWS.count, SCALE);
const VIEW = aim(F8, BOX, { scale: SCALE, top: ROWS.from, left: PANE_COL });
const NOTEPAD_SECTION = "notepad-section";
const STATS_HEADER = "stats-header";
const ESTABLISH = 1.2;
const PUSH = 1;
const NOTEPAD_HOLD = 2;
const SECONDS = 9;

export const seeItPlan = (fps: number) => {
  const f = (s: number) => toFrames(s, fps);
  const push = { from: f(ESTABLISH), to: f(ESTABLISH) + f(PUSH) };
  const end = f(SECONDS);
  const t = timeline(F8, fps);

  // The Evidence tab (the ledger) opens as the push lands, and the Notepad tab follows in real time.
  const from = mark(F8, "evidence-tab") - t.seconds(ESTABLISH + PUSH);
  const notepadTo = mark(F8, "notepad-tab") + t.seconds(NOTEPAD_HOLD);
  shownTarget(F8, NOTEPAD_SECTION, notepadTo);
  const tabs = t.play(from, notepadTo);
  const notepadAt = Math.round(((mark(F8, "notepad-tab") - from) * fps) / F8.fps);
  // The pane closes and `/omca stats` reopens it on the Stats page; the cut lands on that page.
  const statsTo = target(F8, STATS_HEADER).to - SETTLE;
  shownTarget(F8, STATS_HEADER, statsTo);
  const stats = t.play(mark(F8, "stats-tab"), statsTo);
  t.fill(statsTo, SECONDS);

  return {
    t,
    keyframes: [...pushIn(VIEW, 7, push), { ...VIEW, frame: notepadAt, target: NOTEPAD_SECTION }, { ...VIEW, frame: stats.start, target: STATS_HEADER }],
    captions: {
      ledger: { from: push.to, duration: notepadAt - push.to },
      notepad: { from: notepadAt, duration: tabs.duration - notepadAt },
      stats: { from: stats.start, duration: end - crossfadeFrames(fps) - stats.start },
    },
    duration: end,
  };
};

/** The /omca pane's ledger, notepad and stats. */
export const SeeIt = () => {
  const { fps } = useVideoConfig();
  const plan = seeItPlan(fps);
  return (
    <Canvas>
      <Shot clip={F8} box={BOX} keyframes={plan.keyframes} segments={plan.t.segments} />
      <Timed {...plan.captions.ledger}>
        <Caption text="Every run, by day." />
      </Timed>
      <Timed {...plan.captions.notepad}>
        <Caption text="Notes that outlive compaction." />
      </Timed>
      <Timed {...plan.captions.stats}>
        <Caption text="What each agent cost." />
      </Timed>
    </Canvas>
  );
};
