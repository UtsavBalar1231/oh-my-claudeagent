import { color, mono, SAFE, time, useMotion } from "../theme.ts";

const TONES = [color.accent, color.muted, color.text];

export type ChapterTagProps = { index: number; label: string };

export const ChapterTag = ({ index, label }: ChapterTagProps) => {
  const { enter, leave } = useMotion();
  const parts = [String(index).padStart(2, "0"), "·", label.toUpperCase()];
  return (
    <div
      style={{
        position: "absolute",
        left: SAFE.x,
        top: SAFE.top,
        display: "flex",
        gap: "0.6em",
        fontFamily: mono,
        fontWeight: 600,
        fontSize: 32,
        lineHeight: 1,
        letterSpacing: "0.1em",
        opacity: 1 - leave(),
      }}
    >
      {parts.map((part, i) => {
        const shown = enter(i * time.stagger);
        return (
          <span key={i} style={{ color: TONES[i], opacity: shown, translate: `${(1 - shown) * -16}px 0` }}>
            {part}
          </span>
        );
      })}
    </div>
  );
};
