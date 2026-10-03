import type { CSSProperties } from "react";
import { assertWords, color, SAFE, serif, time, useMotion } from "../theme.ts";

const RISE = 8;

// reveal false starts on the finished line, for a frame 0 that must already read; exit false keeps
// it to the end, for a Still, whose one-frame duration would otherwise put it inside the exit.
export type CaptionProps = { text: string; size?: number; placement?: "lower" | "center" | "top"; reveal?: boolean; exit?: boolean };

const PLACEMENT: Record<NonNullable<CaptionProps["placement"]>, CSSProperties> = {
  lower: { bottom: SAFE.bottom + 16 },
  center: { top: "50%", translate: "0 -50%" },
  top: { top: SAFE.top + 40 },
};

export const Caption = ({ text, size = 80, placement = "lower", reveal = true, exit = true }: CaptionProps) => {
  const { enter, leave } = useMotion();
  assertWords(text, 7);
  if (size < 72) throw new Error(`hero captions are at least 72 px, got ${size}`);
  const out = exit ? leave() : 0;
  return (
    <div
      style={{
        position: "absolute",
        left: SAFE.x,
        right: SAFE.x,
        ...PLACEMENT[placement],
        textAlign: "center",
        fontFamily: serif,
        fontSize: size,
        lineHeight: 1.1,
        color: color.text,
        textShadow: "0 2px 24px rgba(0, 0, 0, 0.6)",
        opacity: 1 - out,
      }}
    >
      <span
        style={{
          display: "inline-block",
          padding: "0.06em 0.4em 0.14em",
          borderRadius: 18,
          background: `rgba(9, 9, 11, ${0.72 * (reveal ? enter() : 1)})`,
          translate: `0 ${-RISE * out}px`,
        }}
      >
        {text.split(" ").map((word, i) => {
          const shown = reveal ? enter(i * time.word) : 1;
          return (
            <span key={i} style={{ display: "inline-block", whiteSpace: "pre", opacity: shown, translate: `0 ${RISE * (1 - shown)}px` }}>
              {i === 0 ? word : ` ${word}`}
            </span>
          );
        })}
      </span>
    </div>
  );
};
