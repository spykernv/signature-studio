/**
 * The animation — ShutterDiagonal and NameReveal, ported from Remotion/DOM to Canvas 2D.
 *
 * THE ONE INVARIANT. The bands are an OVERLAY, not a collage. The photograph is laid down
 * once per band at the SAME place every time; what moves is the CLIP POLYGON. In the DOM
 * version the displacement lives entirely in the polygon's coordinates and the <Img> inside
 * it carries no transform — so the face stays continuous and aligned across all five bands.
 * The obvious-looking canvas translation (`translate(0, dy)` then draw) is the bug that
 * sliced the face into offset fragments and took the GIF from 70 KB to 415 KB: every band
 * then differs from the previous frame over its whole area, which destroys the inter-frame
 * compression the encoder depends on. So: save() → clip(polygon) → drawImage(photo, 0, 0)
 * → restore(), photo always at the origin of photo space.
 *
 * The white slashes are NOT produced by the displacement. Sliding a window along its own
 * axis is parallel to the cut and opens no gap at all — the slashes are cut into the
 * geometry, each strip being GAP/2 narrower than its slot on both sides, which is why they
 * keep a constant thickness wherever a band happens to be.
 *
 * WORKER-ONLY. Everything here runs in a Web Worker: no window, no document, OffscreenCanvas
 * only. The single browser dependency is the text measurement in drawNameFrame, and the font
 * trap that comes with it is documented there.
 *
 * Timings are transcribed from jonathan-naal/videos/src/Signature — they were tuned by eye
 * over several rounds and are not to be re-derived.
 */

import {
  PHOTO_W,
  PHOTO_H,
  PAD,
  CANVAS_W,
  CANVAS_H,
  BANDS,
  SLOPE,
  OVERFLOW,
  SPAN,
  GAP,
  type BandGeometry,
} from "./geometry";

/**
 * 25 fps exactly, because GIF frame delays are integer centiseconds: 25 fps = 4cs. 24 or 30
 * land on 4.17 / 3.33, get rounded by the mail client, and the loop judders.
 */
export const FPS = 25;

/**
 * The loop is mostly a HOLD on the resting state with the choreography as a short event —
 * a signature that moves permanently is unbearable in an inbox, and holds are almost free to
 * encode. Portrait and wordmark share this length so the two GIFs, each of which starts
 * looping when it loads, keep a constant phase relationship instead of drifting apart.
 */
export const LOOP = 110;

/** Pure white: the GIFs bleed into the (white) mail body, so the slashes read as gaps and
 * not as a framed box. Near-white would show as a grey rectangle on Gmail. */
export const BG = "#ffffff";
export const INK = "#0a0a0a";

/**
 * Band 0 starts coming back while bands 3 and 4 are still on their way out, so the photo is
 * never completely hidden. The last band leaves at 18 + 4·5 = 38 and lands at 54; everything
 * from 54 to the end of the loop is the resting hold.
 */
export const SCATTER_START = 12;
export const SCATTER_DUR = 8;
export const SCATTER_STAGGER = 1;
export const ARRIVE_START = 18;
export const ARRIVE_DUR = 16;
export const ARRIVE_STAGGER = 5;

/** The frame from which every band is home. Frame 0 and every frame past this are identical. */
export const SETTLED = ARRIVE_START + (BANDS - 1) * ARRIVE_STAGGER + ARRIVE_DUR; // 54

/** Remotion's Easing.in(Easing.cubic) / Easing.out(Easing.cubic), spelled out. */
const easeInCubic = (t: number): number => t * t * t;
const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

/**
 * Remotion's `interpolate(frame, [start, start + dur], [0, 1], { clamp, easing })`.
 * Order matters: Remotion clamps the INPUT and eases afterwards, so the eased value is
 * exactly 0 before the window and exactly 1 after it. Easing first, then clamping, would
 * leave ease-in cubic overshooting past 1 on the far side.
 */
const ramp = (frame: number, start: number, dur: number, ease: (t: number) => number): number =>
  ease(Math.min(1, Math.max(0, (frame - start) / dur)));

export type Point = [number, number];

/**
 * Where band `k`'s window sits at `frame`, in photo pixels (y = 0 is the top of the
 * photograph, not of the canvas).
 *
 * Even bands rest low and leave downwards, odd bands rest high and leave upwards. That
 * alternation is the whole effect: a band returns from the side it rests on, so as its window
 * slides back over the photo it wipes it into view rather than carrying it along.
 */
export function bandWindow(
  k: number,
  frame: number,
  geom: BandGeometry,
): { top: number; bottom: number } {
  const low = k % 2 === 0;

  const restTop = low ? geom.lowTop : geom.highTop;
  // Parked just clear of the photograph, on the side the band rests toward — no further,
  // because every extra pixel of travel is time the band spends invisible.
  const parkedTop = low ? PHOTO_H + 4 : -geom.windowH - 4;

  const scattered = ramp(frame, SCATTER_START + k * SCATTER_STAGGER, SCATTER_DUR, easeInCubic);
  const arrived = ramp(frame, ARRIVE_START + k * ARRIVE_STAGGER, ARRIVE_DUR, easeOutCubic);

  // scattered − arrived reads 0 → 1 → 0 across the loop, so the window sits at its resting
  // height both before the scatter and after the arrival with no special-casing of either end.
  const top = restTop + (parkedTop - restTop) * (scattered - arrived);
  return { top, bottom: top + geom.windowH };
}

/**
 * Band `k`'s clip polygon for a window spanning [top, bottom], in photo pixels, clockwise
 * from the top-left corner.
 *
 * Each corner is evaluated at ITS OWN edge's y. That is what carries the lean — the
 * parallelogram is built leaning, rather than a rectangle being skewed by a transform, and
 * so the photograph underneath is never touched.
 */
export function bandPolygon(k: number, top: number, bottom: number): Point[] {
  const slot = -OVERFLOW + k * SPAN;
  const left = (y: number): number => slot + GAP / 2 - SLOPE * y;
  const right = (y: number): number => slot + SPAN - GAP / 2 - SLOPE * y;

  return [
    [left(top), top],
    [right(top), top],
    [right(bottom), bottom],
    [left(bottom), bottom],
  ];
}

/**
 * Draw one frame of the portrait clip onto a CANVAS_W × CANVAS_H context.
 *
 * `photo` must already be graded and sized PHOTO_W × PHOTO_H, so the draw is 1:1 and nothing
 * is resampled. The background is repainted every frame: the DOM version was an AbsoluteFill
 * over BG, and a caller that reuses one canvas for the whole sequence would otherwise smear
 * the previous frame through the slashes.
 */
export function drawShutterFrame(
  ctx: OffscreenCanvasRenderingContext2D,
  photo: CanvasImageSource,
  frame: number,
  geom: BandGeometry,
): void {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Only matters if a caller hands in a bitmap that is not exactly PHOTO_W × PHOTO_H (a 2x
  // grade, say). Costs nothing when the sizes already agree, and a bilinear downscale of a
  // face is far kinder to a 32-colour palette than a nearest-neighbour one.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // Photo space: the polygons and the photograph share this origin, which is what lets the
  // polygon coordinates be written exactly as the DOM version wrote them.
  ctx.save();
  ctx.translate(PAD, PAD);

  for (let k = 0; k < BANDS; k += 1) {
    const { top, bottom } = bandWindow(k, frame, geom);
    const poly = bandPolygon(k, top, bottom);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(poly[0][0], poly[0][1]);
    for (let i = 1; i < poly.length; i += 1) ctx.lineTo(poly[i][0], poly[i][1]);
    ctx.closePath();
    ctx.clip();
    // The photograph, unmoved. Every band draws it here — see the header.
    ctx.drawImage(photo, 0, 0, PHOTO_W, PHOTO_H);
    ctx.restore();
  }

  ctx.restore();
}

/* ------------------------------------------------------------------------------------- */
/* The wordmark — the typewriter                                                          */
/* ------------------------------------------------------------------------------------- */

export const NAME_W = 360;
export const NAME_H = 56;

const FONT_SIZE = 30;
const FONT_WEIGHT = 600;

/**
 * Fixed advance. The face is monospace, so a STEP-wide centred box per glyph makes the grid
 * exact and independent of the font's real metrics — which is also why the layout below can
 * be computed, and unit-tested, without a canvas.
 */
export const STEP = 23;

const CARET_W = 10;
const CARET_H = 30;
const CARET_PERIOD = 14;

/**
 * Deletion is fast and even (that is how a held backspace behaves); typing is slower and
 * slightly irregular, because a perfectly metronomic rate reads as a machine rather than as
 * someone typing. The line is BACKSPACED away rather than cut, because a loop has to return
 * to empty somehow and a hard cut there reads as a dropped frame.
 */
const DELETE_START = 18;
const DELETE_PER = 1;
const TYPE_START = 38;

/**
 * Deterministic pseudo-random in [−1, 1]. Math.random() would make two renders of the same
 * signature differ, and the studio compares them.
 */
export const noise = (a: number, b: number): number => {
  const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return (n - Math.floor(n)) * 2 - 1;
};

/**
 * The longest name the grid holds. Derived, not chosen: the caret parks after the last glyph,
 * so the completed line plus the caret must fit the fixed width — with X0 centring the line,
 * `X0 + n·STEP + CARET_W ≤ NAME_W` collapses to `n·STEP ≤ NAME_W − 2·CARET_W`. That is 14.
 */
export const MAX_NAME_CHARS = Math.floor((NAME_W - 2 * CARET_W) / STEP); // 14

/**
 * Characters whose advance the monospace grid can be trusted with: Latin letters (including
 * Latin-1 Supplement and Latin Extended-A, minus the × and ÷ that sit inside those ranges),
 * space, and the three marks that occur in names. Everything else — CJK, which is
 * double-width; combining marks, which have zero advance; emoji — would drift off the
 * STEP grid glyph by glyph and collide with the caret.
 */
const GRID_SAFE = /^[A-Za-zÀ-ÖØ-öø-ɏ][A-Za-zÀ-ÖØ-öø-ɏ .'’-]*$/;

/**
 * Owner's decision: the wordmark ships as a GIF when the name fits this grid, and falls back
 * to live HTML text otherwise. Rendering a 20-character name into a 360px GIF would mean
 * shrinking the type until it stops matching the rest of the signature, and a name is not
 * something to get subtly wrong — live text is the honest fallback.
 *
 * Tested against the UPPER-CASED string because that is what gets drawn, and upper-casing can
 * lengthen it (ß → SS).
 */
export function nameFitsGrid(name: string): boolean {
  const text = name.trim().toUpperCase();
  return text.length > 0 && text.length <= MAX_NAME_CHARS && GRID_SAFE.test(text);
}

export interface NameLayout {
  /** The string as it will be drawn: trimmed and upper-cased. */
  text: string;
  /** Left edge of the grid. Left-aligned so the line grows from the left as it is typed; X0
   * is chosen so the COMPLETED line is centred, since the resting state is the one that must
   * look right. */
  x0: number;
  /** Frame at which glyph i appears. */
  typeAt: number[];
  /** Frame at which the line is empty. */
  deleteEnd: number;
  /** Frame at which the last glyph has settled and the caret may resume blinking. */
  typeEnd: number;
}

/** Pure grid layout — no font, no canvas, so the whole schedule is unit-testable. */
export function nameLayout(name: string): NameLayout {
  const text = name.trim().toUpperCase();
  const len = text.length;

  const typeAt: number[] = [];
  let t = TYPE_START;
  for (let i = 0; i < len; i += 1) {
    typeAt.push(t);
    t += 2 + Math.round(Math.abs(noise(i, 7)) * 2); // 2 to 4 frames per keystroke
  }

  return {
    text,
    x0: (NAME_W - len * STEP) / 2,
    typeAt,
    deleteEnd: DELETE_START + len * DELETE_PER,
    typeEnd: len > 0 ? typeAt[len - 1] + 4 : TYPE_START,
  };
}

/** How many glyphs of the line are on screen at `frame`. */
export function visibleCount(frame: number, layout: NameLayout): number {
  const len = layout.text.length;
  if (frame < DELETE_START) return len; // frame 0 IS the finished line — Outlook shows only it
  if (frame < layout.deleteEnd) return len - Math.floor((frame - DELETE_START) / DELETE_PER);
  if (frame < TYPE_START) return 0;
  return layout.typeAt.filter((at) => frame >= at).length;
}

/** A caret holds steady while keys are being pressed and blinks only when the line is idle —
 * the inverse looks broken. */
export function caretVisible(frame: number, layout: NameLayout): boolean {
  const busy = frame >= DELETE_START && frame < layout.typeEnd;
  return busy || frame % CARET_PERIOD < CARET_PERIOD / 2;
}

/**
 * Baseline for a glyph vertically centred the way CSS `line-height: NAME_H` centred it:
 * the font's content box (ascent + descent) is centred in the line box and the baseline sits
 * at half-leading + ascent. `textBaseline: "middle"` uses the em box instead and lands a
 * pixel or so off — small, but the wordmark is 30px tall on a 56px canvas and this is the
 * kind of drift that shows up when the GIF is diffed against the reference frames. Precision
 * over convenience, deliberately.
 */
function glyphBaseline(ctx: OffscreenCanvasRenderingContext2D): {
  baseline: CanvasTextBaseline;
  y: number;
} {
  const m = ctx.measureText("M");
  const a = m.fontBoundingBoxAscent;
  const d = m.fontBoundingBoxDescent;
  // Typed as number but genuinely absent on older engines, hence the runtime check.
  if (typeof a === "number" && typeof d === "number" && a + d > 0) {
    return { baseline: "alphabetic", y: (NAME_H - (a + d)) / 2 + a };
  }
  return { baseline: "middle", y: NAME_H / 2 };
}

/**
 * Draw one frame of the wordmark onto a NAME_W × NAME_H context.
 *
 * THE FONT TRAP: canvas text does not wait for a webfont. If the family is not already loaded
 * when fillText runs, the browser silently substitutes a default and every glyph lands with
 * different metrics — the first frames of the sequence come out in the wrong face and nothing
 * throws. In a worker there is no `document.fonts`; load it into the worker's own FontFaceSet
 * before the first draw:
 *
 *     const face = new FontFace("Geist Mono", buffer);   // ArrayBuffer, not a URL
 *     await face.load();
 *     self.fonts.add(face);                             // WorkerGlobalScope.fonts
 *
 * `fontFamily` is a CSS family LIST, quoted by the caller — e.g. `'"Geist Mono", monospace'`
 * — rather than hardcoded, so the studio can offer a face without this module knowing it.
 */
export function drawNameFrame(
  ctx: OffscreenCanvasRenderingContext2D,
  frame: number,
  layout: NameLayout,
  fontFamily: string,
): void {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, NAME_W, NAME_H);

  ctx.font = `${FONT_WEIGHT} ${FONT_SIZE}px ${fontFamily}`;
  // No WebkitFontSmoothing to worry about here, unlike the DOM version: canvas text is
  // greyscale-antialiased, never subpixel, so no red/cyan fringes reach the greyscale palette.
  ctx.fillStyle = INK;
  ctx.textAlign = "center";

  const { baseline, y } = glyphBaseline(ctx);
  ctx.textBaseline = baseline;

  const count = visibleCount(frame, layout);
  for (let i = 0; i < count; i += 1) {
    const char = layout.text[i];
    if (char === " ") continue;
    ctx.fillText(char, layout.x0 + i * STEP + STEP / 2, y);
  }

  if (caretVisible(frame, layout)) {
    ctx.fillRect(layout.x0 + count * STEP, (NAME_H - CARET_H) / 2, CARET_W, CARET_H);
  }
}
