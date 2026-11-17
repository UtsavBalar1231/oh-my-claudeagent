import { LottieClip } from "../components/LottieClip.tsx";
import { color, mono, toFrames, useMotion } from "../theme.ts";
import { Canvas } from "./shot.tsx";

const TAGLINE = "Claude Code, with receipts.";

// The ident is 1920x540 and its mascots fill rows 190 to 350 of it (measured on its frame 120).
// At 0.8 its 10 px cells draw as 8 px, still whole pixels, and the row clears the frame's sides.
// The mascots, the wordmark and the tagline are centered as one group on the frame.
const IDENT_SCALE = 0.8;
const IDENT = { width: 1920 * IDENT_SCALE, height: 540 * IDENT_SCALE, top: 190 * IDENT_SCALE, bottom: 350 * IDENT_SCALE } as const;
const GAP = { wordmark: 72, tagline: 28 } as const;
const WORDMARK = 88;
const TAGLINE_SIZE = 33;
const GROUP = IDENT.bottom - IDENT.top + GAP.wordmark + WORDMARK + GAP.tagline + TAGLINE_SIZE;
const FADE = 0.25;

export const titlePlan = (fps: number, seconds = 3) => ({ duration: toFrames(seconds, fps) });

export const Title = () => {
  const { enter, width, height } = useMotion();
  const groupTop = Math.round((height - GROUP) / 2);
  return (
    <Canvas>
      <div style={{ position: "absolute", left: (width - IDENT.width) / 2, top: groupTop - IDENT.top, width: IDENT.width, height: IDENT.height }}>
        <LottieClip file="lottie/omca-ident.json" />
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: groupTop + IDENT.bottom - IDENT.top + GAP.wordmark,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: GAP.tagline,
          fontFamily: mono,
          lineHeight: 1,
          color: color.title,
          opacity: enter(0, FADE),
        }}
      >
        <div style={{ fontSize: WORDMARK }}>oh-my-claudeagent</div>
        <div style={{ fontSize: TAGLINE_SIZE }}>{TAGLINE}</div>
      </div>
    </Canvas>
  );
};
