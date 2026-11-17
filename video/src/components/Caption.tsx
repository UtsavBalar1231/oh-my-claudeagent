import { assertWords, color, mono, SAFE, useMotion, VIDEO } from "../theme.ts";

const FADE = 0.25;

/** `size` is a pixel size that replaces the 1080p size scaled with the frame, for a composition whose scaled caption is too small to read. */
export const Caption = ({ text, size }: { text: string; size?: number | undefined }) => {
  const { enter, leave, height } = useMotion();
  const k = height / VIDEO.height;
  assertWords(text);
  return (
    <div
      style={{
        position: "absolute",
        left: SAFE.x * k,
        right: SAFE.x * k,
        bottom: (SAFE.bottom + 16) * k,
        textAlign: "center",
        fontFamily: mono,
        fontSize: size ?? 30 * k,
        lineHeight: 1.2,
        color: color.caption,
        opacity: enter(0, FADE) * (1 - leave(FADE)),
      }}
    >
      {text}
    </div>
  );
};
