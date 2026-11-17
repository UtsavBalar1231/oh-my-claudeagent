import { useVideoConfig } from "remotion";
import { LottieClip } from "../components/LottieClip.tsx";
import { mark, type Rect, shownTarget, target } from "../footage.ts";
import { color, mono, toFrames } from "../theme.ts";
import { INSTALL } from "./clips.ts";
import { aim, Canvas, pushIn, SETTLE, Shot, timeline } from "./shot.tsx";

const URL = "github.com/UtsavBalar1231/oh-my-claudeagent";
const DISCLOSURE = "Real Claude Code sessions. Model replies are scripted.";
const INSTALLED_ROW = "installed-row";

// The legibility floor for clip-install's 50 px cells at 1080p (36 px). At this scale the install's
// widest rows, columns 5 to 118, take 1806 px, so the window is that wide plus half a cell each side;
// rows 7 to 16 run from the first output row to the blank row above the model's reply, so no
// prompt marker or bullet in column 0 meets the window's edge.
const SCALE = 0.72;
const COLS = { from: 4.5, count: 115 };
const ROWS = { from: 7, count: 10 };
// omca-mark.json is 512 px at 40 px per cell, so half size draws whole 20 px cells. The pebble
// covers its rows 18 to 238 at that size.
const MARK = 256;
const INK = { top: 18, bottom: 238 };
const URL_SIZE = 36;
const DISCLOSURE_SIZE = 26;
const GAP = { plane: 44, url: 56, disclosure: 20 } as const;
const PLANE = { width: COLS.count * INSTALL.cell.width * SCALE, height: ROWS.count * INSTALL.cell.height * SCALE };
const GROUP = INK.bottom - INK.top + GAP.plane + PLANE.height + GAP.url + URL_SIZE + GAP.disclosure + DISCLOSURE_SIZE;
const ESTABLISH = 1.5;
const PUSH = 1.2;
const SECONDS = 8;

export const endCardPlan = (fps: number, frame: { width: number; height: number }) => {
  const f = (s: number) => toFrames(s, fps);
  const push = { from: f(ESTABLISH), to: f(ESTABLISH) + f(PUSH) };
  const inkTop = Math.round((frame.height - GROUP) / 2);
  const markTop = inkTop - INK.top;
  const box: Rect = { x: Math.round((frame.width - PLANE.width) / 2), y: inkTop + INK.bottom - INK.top + GAP.plane, width: PLANE.width, height: PLANE.height };
  const view = aim(INSTALL, box, { scale: SCALE, top: ROWS.from, left: COLS.from });

  // The success row paints as the push lands.
  const t = timeline(INSTALL, fps);
  const installedTo = target(INSTALL, INSTALLED_ROW).to - SETTLE;
  shownTarget(INSTALL, INSTALLED_ROW, installedTo);
  t.play(mark(INSTALL, "installed") - t.seconds(ESTABLISH + PUSH), installedTo);
  t.fill(installedTo, SECONDS);

  return {
    t,
    box,
    keyframes: pushIn(view, -7, push, INSTALLED_ROW),
    mark: { left: (frame.width - MARK) / 2, top: markTop },
    url: box.y + box.height + GAP.url,
    disclosure: box.y + box.height + GAP.url + URL_SIZE + GAP.disclosure,
    duration: f(SECONDS),
  };
};

const line = { position: "absolute", left: 0, right: 0, textAlign: "center", fontFamily: mono, lineHeight: 1 } as const;

/** The mark, the install pushed in on its success row, the repository and the disclosure. */
export const EndCard = () => {
  const { fps, width, height } = useVideoConfig();
  const plan = endCardPlan(fps, { width, height });
  return (
    <Canvas>
      <div style={{ position: "absolute", left: plan.mark.left, top: plan.mark.top, width: MARK, height: MARK }}>
        <LottieClip file="lottie/omca-mark.json" />
      </div>
      <Shot clip={INSTALL} box={plan.box} keyframes={plan.keyframes} segments={plan.t.segments} />
      <div style={{ ...line, top: plan.url, fontSize: URL_SIZE, color: color.title }}>{URL}</div>
      <div style={{ ...line, top: plan.disclosure, fontSize: DISCLOSURE_SIZE, color: color.caption }}>{DISCLOSURE}</div>
    </Canvas>
  );
};
