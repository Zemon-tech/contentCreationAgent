import sharp from "sharp";

/**
 * Instagram's publishing API only accepts JPEG (aspect 4:5 to 1.91:1, <= 8 MB,
 * width 320-1440, sRGB). RAS renders PNG, so we write a JPEG sibling next to
 * every post we render and publish THAT. The PNG is kept for Studio previews.
 * RAS's own files and routes are untouched.
 */
export async function pngToInstagramJpeg(png: Buffer): Promise<Buffer> {
  return sharp(png)
    .flatten({ background: "#ffffff" }) // JPEG has no alpha
    .toColourspace("srgb")
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4", mozjpeg: true })
    .toBuffer();
}

export const IG_MAX_BYTES = 8 * 1024 * 1024;
