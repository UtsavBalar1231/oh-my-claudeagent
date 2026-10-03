import { color, mono, time, toFrames, useMotion } from "../theme.ts";

/** startAt is in seconds. */
export type TypewriterProps = { text: string; startAt?: number; size?: number; cursor?: boolean };

export const typingSeconds = (text: string): number => text.length * time.char;

// The untyped rest stays in the layout, hidden, so centered text does not shift while it types;
// the cursor takes no width and covers the next character cell, like a terminal block cursor.
export const Typewriter = ({ text, startAt = 0, size = 36, cursor = true }: TypewriterProps) => {
  const { frame, fps, f } = useMotion();
  const start = f(startAt);
  const step = Math.max(1, toFrames(time.char, fps));
  const shown = Math.max(0, Math.min(text.length, Math.floor((frame - start) / step)));
  const typing = frame >= start && shown < text.length;
  const lit = typing || frame % fps < fps / 2;
  return (
    <span style={{ fontFamily: mono, fontSize: size, lineHeight: 1.3, color: color.text, whiteSpace: "pre" }}>
      {text.slice(0, shown)}
      {cursor ? (
        <span
          style={{
            display: "inline-block",
            width: "0.6em",
            height: "1.15em",
            marginRight: "-0.6em",
            verticalAlign: "text-bottom",
            background: color.text,
            opacity: lit ? 0.9 : 0,
          }}
        />
      ) : null}
      <span style={{ visibility: "hidden" }}>{text.slice(shown)}</span>
    </span>
  );
};
