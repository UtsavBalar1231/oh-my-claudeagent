declare module "subset-font" {
  export default function subsetFont(
    font: Buffer,
    text: string,
    options?: {
      targetFormat?: "sfnt" | "woff" | "woff2";
      keepFeatures?: string[];
      noHinting?: boolean;
      noLayoutClosure?: boolean;
      preserveNameIds?: number[];
    },
  ): Promise<Buffer>;
}
