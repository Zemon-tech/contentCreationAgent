// Ambient type shim for the `sharp` package.
//
// Root cause: sharp 0.35.5's package.json "exports" map points the ESM type
// entry at dist/index.d.mts, but that file does NOT exist in the installed
// build — only dist/index.d.cts ships. Under moduleResolution "bundler",
// TypeScript resolves the ESM runtime (dist/index.mjs) and, finding no matching
// declaration, emits TS7016 ("Could not find a declaration file for module
// 'sharp'") for every `import sharp from "sharp"` and `import type { ... }`.
//
// This shim re-exports the existing .d.cts declarations under the bare "sharp"
// specifier so both the default export and the named type members resolve.
// This types dir is auto-included by tsconfig's include ['src/**/*'].
declare module "sharp" {
  import * as sharpNs from "sharp/dist/index.d.cts";
  const sharp: typeof sharpNs;
  export default sharp;
  export import Sharp = sharpNs.Sharp;
  export import Metadata = sharpNs.Metadata;
  export import OutputInfo = sharpNs.OutputInfo;
  export import SharpOptions = sharpNs.SharpOptions;
  export import ResizeOptions = sharpNs.ResizeOptions;
}
