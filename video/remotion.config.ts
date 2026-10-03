import { Config } from "@remotion/cli/config";

// CRF stays on the command line: a CRF set here also applies to GIF renders, which reject it.
Config.setVideoImageFormat("png");
Config.setPixelFormat("yuv420p");
Config.setColorSpace("bt709");
Config.setCodec("h264");
