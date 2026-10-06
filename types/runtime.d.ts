// The engine's runtime has it; the es2023 lib the mod compiles against does not declare it yet.
// Kept out of the manifest's `types` file, which may declare nothing global.
interface Uint8ArrayConstructor {
  fromBase64(text: string): Uint8Array;
}
