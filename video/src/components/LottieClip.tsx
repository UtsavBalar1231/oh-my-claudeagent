import { Lottie, type LottieAnimationData } from "@remotion/lottie";
import { useEffect, useState } from "react";
import { cancelRender, continueRender, delayRender, staticFile } from "remotion";

// Lottie advances one animation frame per composition frame, so a composition slower than the animation's own rate passes `playbackRate`.
export const LottieClip = ({ file, playbackRate = 1 }: { file: string; playbackRate?: number }) => {
  const [data, setData] = useState<LottieAnimationData | null>(null);
  const [handle] = useState(() => delayRender(`load ${file}`));

  useEffect(() => {
    fetch(staticFile(file))
      .then((response) => response.json() as Promise<LottieAnimationData>)
      .then((json) => {
        setData(json);
        continueRender(handle);
      })
      .catch((error: unknown) => cancelRender(error));
  }, [file, handle]);

  if (data === null) return null;
  return <Lottie animationData={data} loop={false} playbackRate={playbackRate} renderer="svg" style={{ width: "100%", height: "100%" }} />;
};
