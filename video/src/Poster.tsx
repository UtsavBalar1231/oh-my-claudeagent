import { AbsoluteFill, Img, staticFile } from "remotion";
import { fitWindow } from "./components/Camera.tsx";
import { Caption } from "./components/Caption.tsx";
import { Window } from "./components/Window.tsx";
import { color, mono } from "./theme.ts";

export const Poster = () => (
  <AbsoluteFill style={{ background: color.canvas }}>
    <Window box={fitWindow({ width: 2232, height: 1282 })}>
      <Img src={staticFile("placeholder/hero.png")} style={{ width: "100%", height: "100%", objectFit: "cover", opacity: 0.3 }} />
    </Window>
    <Caption text="Done means proven." size={84} placement="center" reveal={false} exit={false} />
    <div
      style={{
        position: "absolute",
        top: "50%",
        left: 0,
        right: 0,
        marginTop: 84,
        textAlign: "center",
        fontFamily: mono,
        fontSize: 32,
        letterSpacing: "0.04em",
        color: color.muted,
      }}
    >
      oh-my-claudeagent · for Claude Code
    </div>
  </AbsoluteFill>
);
