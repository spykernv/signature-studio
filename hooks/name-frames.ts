/**
 * The wordmark's 110 frames, drawn on the main thread.
 *
 * WHY NOT IN THE WORKER, where the other 110 frames are drawn. `drawNameFrame` is the one part
 * of the pipeline that needs a font, and a worker does not inherit the document's fonts: the
 * face has to be fetched as an ArrayBuffer and added to the worker's own FontFaceSet first.
 * Miss that and nothing throws — `ctx.font` silently falls back to the platform default and the
 * name is typed out in the wrong face, which looks almost right and is not caught by any test.
 * Getting the font bytes means digging the hashed `/_next/static/media/*.woff2` URL out of a
 * stylesheet at runtime, which is a dependency on a build detail that is not ours.
 *
 * Here the font is simply already loaded, and `document.fonts.load` gives a real signal that it
 * is. The cost is 110 draws of a 360x56 canvas on the main thread — a few tens of milliseconds,
 * once, on a screen that is already showing a progress bar. The expensive half (the palette and
 * the LZW pass over 2.2 million pixels) still happens in the worker, which is handed the frames
 * as pixels.
 *
 * `fontFamily` comes from `MONO_FAMILY` in app/layout.tsx, not from the `--font-geist-mono` CSS
 * variable: `ctx.font` takes a CSS font shorthand and will not resolve a custom property.
 */

import { LOOP, NAME_H, NAME_W, drawNameFrame, nameLayout } from "@/lib/render";

const FONT_SHORTHAND = (family: string) => `600 30px ${family}`;

/** Wordmark frames are only ever wanted for a name `nameFitsGrid()` accepted. */
export async function renderNameFrames(
  name: string,
  fontFamily: string,
): Promise<ImageData[]> {
  const layout = nameLayout(name);
  if (layout.text.length === 0) return [];

  if (typeof OffscreenCanvas !== "function") {
    throw new Error("this browser has no OffscreenCanvas");
  }

  await ensureFont(fontFamily, layout.text);

  const canvas = new OffscreenCanvas(NAME_W, NAME_H);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("this browser refused an OffscreenCanvas 2D context");

  const frames: ImageData[] = [];
  for (let f = 0; f < LOOP; f += 1) {
    drawNameFrame(ctx, f, layout, fontFamily);
    frames.push(ctx.getImageData(0, 0, NAME_W, NAME_H));
  }
  return frames;
}

/**
 * Best effort, deliberately. If the shorthand will not parse, or the face never arrives, the
 * wordmark is drawn in whatever the browser substitutes — a slightly wrong typeface is a far
 * better outcome than refusing to produce a signature, and it is not something the user can act
 * on anyway.
 */
async function ensureFont(fontFamily: string, text: string): Promise<void> {
  try {
    await document.fonts.load(FONT_SHORTHAND(fontFamily), text);
    await document.fonts.ready;
  } catch {
    /* fall through with whatever the platform gives us */
  }
}
