import { AbsoluteFill } from "remotion";
import { color, mono, serif, time, toFrames, useMotion } from "../theme.ts";
import { beatLength, Canvas } from "./shot.tsx";

export const PUNCH_LINE = "Claude Code, with receipts.";
const RISE = 8;

export const punchLinePlan = (fps: number) => ({ duration: toFrames(beatLength(3), fps) });

/** Seconds into the card when the plugin line, the last to rise, has settled. */
export const PUNCH_LINE_SETTLED = PUNCH_LINE.split(" ").length * time.word + 0.2 + time.entrance;

// Black after the sizzle's last cut; the line's words rise on the word-reveal token, then the
// plugin line under it.
export const PunchLine = () => {
  const { enter, leave } = useMotion();
  const words = PUNCH_LINE.split(" ");
  const rise = (p: number) => ({ display: "inline-block", whiteSpace: "pre", opacity: p, translate: `0 ${RISE * (1 - p)}px` }) as const;
  return (
    <Canvas>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: 36, opacity: 1 - leave() }}>
        <div style={{ fontFamily: serif, fontSize: 132, lineHeight: 1, color: color.text }}>
          {words.map((w, i) => (
            <span key={i} style={rise(enter(i * time.word))}>
              {i === 0 ? w : ` ${w}`}
            </span>
          ))}
        </div>
        <div style={{ fontFamily: mono, fontSize: 36, letterSpacing: "0.02em", color: color.muted, ...rise(enter(words.length * time.word + 0.2)) }}>
          oh-my-claudeagent · a plugin for Claude Code
        </div>
      </AbsoluteFill>
    </Canvas>
  );
};
