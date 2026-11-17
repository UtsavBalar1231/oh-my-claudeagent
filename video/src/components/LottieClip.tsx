import { Lottie, type LottieAnimationData } from "@remotion/lottie";
import { useEffect, useState } from "react";
import { cancelRender, continueRender, delayRender, staticFile } from "remotion";

export const LottieClip = ({ file }: { file: string }) => {
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
  return <Lottie animationData={data} loop={false} renderer="svg" style={{ width: "100%", height: "100%" }} />;
};
