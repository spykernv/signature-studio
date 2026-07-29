/**
 * The render pipeline, off the main thread.
 *
 * Everything expensive lives here: the grade (a Lanczos resample of a ~1600px source), 110
 * canvas frames, and two GIF encodes. On the main thread the grade alone janks a drag, and the
 * encode blocks paint for seconds — which is exactly the interval during which the user is
 * watching a progress bar that would then not move.
 *
 * TWO JOBS, ONE SOURCE. The worker holds the source image for the whole session, because it
 * serves both the live preview in step 2 (grade + frame 0, once per drag tick) and the final
 * render in step 4. Holding it here rather than shipping it per request is what makes the
 * preview cheap enough to run while a guide is being dragged.
 *
 * PREVIEW AND FINAL ARE THE SAME PIXELS. The page downsamples the upload to ONE working
 * resolution before it ever gets here, so the preview is not an approximation of the output —
 * it is frame 0 of the output, produced by the same call. A preview that can drift from the
 * result is worse than no preview, since the whole point of step 2 is to let the user see the
 * bands before committing.
 *
 * NO DOM. OffscreenCanvas only. In particular the wordmark is NOT drawn here: canvas text
 * silently falls back to a default face unless the font has been added to *this* scope's
 * FontFaceSet, and a wordmark rendered in the wrong typeface throws nothing and looks almost
 * right. The page draws those frames where the document's fonts are already loaded and posts
 * them in as pixels; this file only encodes them.
 */

import {
  CANVAS_H,
  CANVAS_W,
  PHOTO_H,
  PHOTO_W,
  type BandGeometry,
  type Crop,
} from "../lib/geometry";
import { grade } from "../lib/grade";
import { encodeGif } from "../lib/gif";
import { FPS, LOOP, NAME_H, NAME_W, drawShutterFrame } from "../lib/render";

/* ------------------------------------------------------------------ the protocol ------- */

export type RenderPhase = "grading" | "frames" | "portrait" | "wordmark";

export type StudioRequest =
  /** Sent once per photo. Deliberately NOT transferred — see `source` below. */
  | { type: "source"; source: ImageData }
  | { type: "preview"; id: number; crop: Crop; geom: BandGeometry }
  | {
      type: "render";
      crop: Crop;
      geom: BandGeometry;
      /** Pre-drawn wordmark frames, or null when the name falls back to live HTML text. */
      nameFrames: ImageData[] | null;
    };

export type StudioResponse =
  | { type: "preview"; id: number; bitmap: ImageBitmap }
  | { type: "progress"; phase: RenderPhase; done: number; total: number }
  | { type: "done"; portrait: Uint8Array; wordmark: Uint8Array | null }
  /** `fatal` distinguishes "this render failed" from "this preview failed", which is a shrug. */
  | { type: "error"; message: string; fatal: boolean };

/**
 * ffmpeg's `palettegen=stats_mode=diff:max_colors=24` / `paletteuse=dither=bayer:bayer_scale=3`,
 * the settings the reference GIF was built with. `delayCs` is derived rather than written as 4
 * so it cannot silently disagree with FPS.
 */
const DELAY_CS = Math.round(100 / FPS);
const GIF_OPTIONS = {
  delayCs: DELAY_CS,
  maxColors: 24,
  dither: "bayer",
  bayerScale: 3,
  statsMode: "diff",
} as const;

/** Frames drawn between progress messages. Every frame would post 110 messages and re-render
 * the page 110 times for a bar that moves half a pixel each step. */
const PROGRESS_EVERY = 5;

/**
 * Frames between yields to the event loop. Nothing depends on the worker staying responsive
 * mid-render, but a scope that never yields also cannot be measured or interrupted, and the
 * cost is about a millisecond in total.
 */
const YIELD_EVERY = 10;

/* ------------------------------------------------------------------ scope plumbing ----- */

/**
 * `lib.webworker` is not in this project's tsconfig `lib` (and tsconfig is not ours to edit),
 * so `self` is typed as a Window. Only the three members actually used are declared.
 */
interface WorkerScope {
  postMessage(message: StudioResponse, transfer?: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<StudioRequest>) => void,
  ): void;
}

const scope = self as unknown as WorkerScope;

const post = (message: StudioResponse, transfer?: Transferable[]) =>
  scope.postMessage(message, transfer);

/** A macrotask, so queued messages get a chance to be delivered between batches of frames. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/* ------------------------------------------------------------------ state -------------- */

/**
 * The working source, held for the session. It is cloned rather than transferred on the way in:
 * a transfer neuters the page's copy, and the page needs to be able to re-seed a fresh worker
 * after a failure without asking the user to upload the photo again. One ~13 MB copy at upload
 * time buys that.
 */
let source: ImageData | null = null;

let frameCanvas: OffscreenCanvas | null = null;
let frameCtx: OffscreenCanvasRenderingContext2D | null = null;

function canvas2d(w: number, h: number): {
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
} {
  if (!frameCanvas || frameCanvas.width !== w || frameCanvas.height !== h) {
    frameCanvas = new OffscreenCanvas(w, h);
    // The whole point of this canvas is getImageData, once per frame, 110 times.
    frameCtx = frameCanvas.getContext("2d", {
      willReadFrequently: true,
    }) as OffscreenCanvasRenderingContext2D | null;
  }
  if (!frameCanvas || !frameCtx) throw new Error("this browser cannot draw to an OffscreenCanvas");
  return { canvas: frameCanvas, ctx: frameCtx };
}

/** The graded portrait as a bitmap, ready for `drawShutterFrame` to stamp under each band. */
async function gradedBitmap(crop: Crop, src: ImageData): Promise<ImageBitmap> {
  return createImageBitmap(grade(src, crop, PHOTO_W, PHOTO_H));
}

/* ------------------------------------------------------------------ preview ------------ */

async function handlePreview(req: Extract<StudioRequest, { type: "preview" }>): Promise<void> {
  if (!source) return;

  const photo = await gradedBitmap(req.crop, source);
  try {
    const { canvas, ctx } = canvas2d(CANVAS_W, CANVAS_H);
    // Frame 0 is the resting state, so it is the only frame that is honest as a still.
    drawShutterFrame(ctx, photo, 0, req.geom);
    // transferToImageBitmap hands the backing store over rather than copying it; the canvas is
    // fully repainted on the next call, so losing its contents costs nothing.
    const bitmap = canvas.transferToImageBitmap();
    post({ type: "preview", id: req.id, bitmap }, [bitmap]);
  } finally {
    photo.close();
  }
}

/* ------------------------------------------------------------------ render ------------- */

async function handleRender(req: Extract<StudioRequest, { type: "render" }>): Promise<void> {
  if (!source) throw new Error("no photo has been loaded");

  post({ type: "progress", phase: "grading", done: 0, total: 1 });
  const photo = await gradedBitmap(req.crop, source);
  post({ type: "progress", phase: "grading", done: 1, total: 1 });

  const frames: ImageData[] = [];
  try {
    const { ctx } = canvas2d(CANVAS_W, CANVAS_H);
    for (let f = 0; f < LOOP; f += 1) {
      drawShutterFrame(ctx, photo, f, req.geom);
      frames.push(ctx.getImageData(0, 0, CANVAS_W, CANVAS_H));
      if (f % PROGRESS_EVERY === 0 || f === LOOP - 1) {
        post({ type: "progress", phase: "frames", done: f + 1, total: LOOP });
      }
      if (f % YIELD_EVERY === YIELD_EVERY - 1) await tick();
    }
  } finally {
    photo.close();
  }

  post({ type: "progress", phase: "portrait", done: 0, total: 1 });
  await tick(); // let that message land before the encoder takes the thread
  const portrait = encodeGif(frames, { width: CANVAS_W, height: CANVAS_H, ...GIF_OPTIONS });
  post({ type: "progress", phase: "portrait", done: 1, total: 1 });

  let wordmark: Uint8Array | null = null;
  if (req.nameFrames && req.nameFrames.length > 0) {
    post({ type: "progress", phase: "wordmark", done: 0, total: 1 });
    await tick();
    wordmark = encodeGif(req.nameFrames, { width: NAME_W, height: NAME_H, ...GIF_OPTIONS });
    post({ type: "progress", phase: "wordmark", done: 1, total: 1 });
  }

  post({ type: "done", portrait, wordmark });
}

/* ------------------------------------------------------------------ dispatch ----------- */

/**
 * Requests are serialised. Two renders cannot overlap on one OffscreenCanvas, and a preview
 * that arrives mid-render would otherwise repaint the canvas the render is reading from.
 */
let queue: Promise<void> = Promise.resolve();

scope.addEventListener("message", (event: MessageEvent<StudioRequest>) => {
  const req = event.data;
  queue = queue.then(async () => {
    try {
      switch (req.type) {
        case "source":
          source = req.source;
          break;
        case "preview":
          await handlePreview(req);
          break;
        case "render":
          await handleRender(req);
          break;
      }
    } catch (e) {
      post({ type: "error", message: message(e), fatal: req.type === "render" });
    }
  });
});
