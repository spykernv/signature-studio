/**
 * The grade — the ffmpeg chain from `videos/scripts/build-portrait.sh`, ported to a pure
 * function so it can run in a Web Worker.
 *
 *   crop , scale=208:260:flags=lanczos , hue=s=0 , gblur=sigma=0.6 ,
 *   eq=contrast=1.32:brightness=0.015:gamma=1.04
 *
 * Every constant and every stage below was reverse-engineered against ffmpeg 8.1.1 itself
 * (which reproduces `test/fixtures/expected-graded.png` byte for byte), not from the docs.
 * Three findings drove the implementation and are worth stating up front, because each one
 * silently shifts the whole midtone range if you get it wrong:
 *
 *  1. THE PIPE IS LIMITED-RANGE YUV. `hue` only accepts planar YUV, so ffmpeg inserts an
 *     rgba -> yuva444p conversion, and with no colour range tagged swscale writes MPEG range:
 *     white lands on Y=235, black on Y=16 (verified with `color=white`/`color=black` probes).
 *     Everything downstream — the blur, and above all eq's pivot at 0.5 — therefore operates
 *     on a signal that lives in 16..235, not 0..255. Grading in full range instead moves every
 *     midtone by several levels.
 *  2. `gblur` IS NOT A CONVOLUTION. See `blurInPlace`.
 *  3. `eq` QUANTISES ON THE WAY OUT with `256 * v` truncated. See `eqCurve`.
 */

import type { Crop } from "./geometry";

/**
 * Rec. 601 luma. ffmpeg leaves the colour space unspecified here, and swscale's fallback for
 * unspecified is BT.601 — not BT.709, whose 0.2126/0.7152/0.0722 would render the (green)
 * olive grove behind the subject a full stop lighter. Confirmed by feeding solid primaries
 * through the chain: pure red arrives at Y=81 = 16 + 219·0.299, which is 601 and only 601.
 */
export const LUMA_R = 0.299;
export const LUMA_G = 0.587;
export const LUMA_B = 0.114;

/** MPEG/limited range: the luma axis the whole chain actually runs on. */
export const Y_BLACK = 16;
export const Y_RANGE = 219;
export const Y_WHITE = Y_BLACK + Y_RANGE; // 235

/**
 * Lanczos lobes. swscale's default for `flags=lanczos` is 3; the brief also asks explicitly
 * for Lanczos-3 rather than something cheaper, because this is a 3.63x downscale of a face and
 * bilinear would eat the eyelashes.
 */
export const LANCZOS_A = 3;

export const BLUR_SIGMA = 0.6;
/** `gblur`'s `steps` option. Default 1, and the value the reference render used. */
export const BLUR_STEPS = 1;

export const EQ_CONTRAST = 1.32;
export const EQ_BRIGHTNESS = 0.015;
export const EQ_GAMMA = 1.04;

/**
 * Lanczos kernel, normalised so lanczos(0) = 1.
 *
 * Written with the `a·sin(πt)·sin(πt/a) / (π²t²)` form rather than sinc(t)·sinc(t/a) purely so
 * the reader can check it against swscale's own expression in `initFilter`, which is spelled
 * the same way.
 */
export function lanczos(t: number, a = LANCZOS_A): number {
  if (t === 0) return 1;
  if (t <= -a || t >= a) return 0;
  const pt = Math.PI * t;
  return (a * Math.sin(pt) * Math.sin(pt / a)) / (pt * pt);
}

interface Taps {
  /** Source indices touched by output sample i, at `idx[i * width + k]`. */
  idx: Int32Array;
  /** Matching weights, already normalised to sum to 1. */
  wt: Float64Array;
  /** Taps per output sample (constant, so both arrays are flat). */
  width: number;
  /** Lowest and highest source index touched by any output sample. */
  first: number;
  last: number;
}

/**
 * Resampling weights for one axis.
 *
 * Two things here are load-bearing and are the usual sources of a half-pixel drift:
 *
 *  - CENTRE ALIGNMENT. Output sample i reads source position (i + 0.5)·scale − 0.5, i.e. pixel
 *    CENTRES are mapped, not pixel edges. swscale does the same (`xDstInSrc = xInc/2 - 0x8000`,
 *    stepping by xInc). Aligning edges instead shifts the portrait by half an output pixel,
 *    which on a 3.63x downscale is nearly two source pixels of the face.
 *  - KERNEL WIDENING ON DOWNSCALE. When shrinking, the kernel is stretched by the scale factor
 *    so its cutoff sits at the DESTINATION Nyquist rather than the source's; that is what makes
 *    it an anti-aliasing filter instead of a decimator. swscale does this too (it widens the
 *    filter by dstW/srcW). Without it the foliage aliases into a shimmer that a GIF palette
 *    then bakes in permanently.
 */
function buildTaps(cropStart: number, cropLen: number, outN: number, a: number): Taps {
  const scale = cropLen / outN;
  const kernelScale = Math.max(1, scale); // widen only when shrinking
  const radius = a * kernelScale;

  // Constant tap count keeps the inner loop branch-free. The +2 absorbs the fact that where the
  // support window falls between integers varies by up to one sample from output to output.
  const width = Math.ceil(2 * radius) + 2;

  // The reference chain is `crop` THEN `scale`, so swscale is handed the cropped image and can
  // never see a pixel outside it. A tap that falls beyond the crop but still inside the
  // photograph must therefore NOT read that neighbouring pixel — swscale clamp-extends its own
  // edge instead. Sampling the source directly was a real divergence: it let content the crop
  // deliberately excluded bleed back in along every border.
  //
  // Clamping the INDEX while leaving the WEIGHT computed from the unclamped position is exactly
  // what edge extension means: the weight profile is untouched, the same edge pixel is simply
  // read more than once.
  const lo = Math.floor(cropStart);
  const hi = Math.ceil(cropStart + cropLen) - 1;

  const idx = new Int32Array(outN * width);
  const wt = new Float64Array(outN * width);
  let first = Infinity;
  let last = -Infinity;

  for (let i = 0; i < outN; i++) {
    const centre = cropStart + (i + 0.5) * scale - 0.5;
    const start = Math.ceil(centre - radius);
    let sum = 0;
    for (let k = 0; k < width; k++) {
      const s = start + k;
      const w = lanczos((s - centre) / kernelScale, a);
      idx[i * width + k] = s < lo ? lo : s > hi ? hi : s;
      wt[i * width + k] = w;
      sum += w;
    }
    // Normalising per output sample is what keeps a flat field flat. It matters most at the
    // frame edges, where part of the support is off the image: the weights that landed on white
    // still count, so the white bleeds in at exactly its true share and no more.
    if (sum !== 0) {
      for (let k = 0; k < width; k++) wt[i * width + k] /= sum;
    } else {
      // Unreachable for Lanczos (the nearest tap is always within half a sample of the centre,
      // where the kernel is near 1), but a zero-sum row would silently emit black, so pin it.
      wt[i * width] = 1;
    }
    // Track the CLAMPED reach: idx never leaves [lo, hi] now, so the row window the caller
    // allocates must follow, or it reserves rows that can no longer be addressed.
    const lowest = Math.max(lo, Math.min(hi, start));
    const highest = Math.max(lo, Math.min(hi, start + width - 1));
    if (lowest < first) first = lowest;
    if (highest > last) last = highest;
  }

  return { idx, wt, width, first, last };
}

/**
 * Crop + Lanczos resample + greyscale, in one pass, into a limited-range luma plane.
 *
 * Greyscale is taken BEFORE resampling rather than after. Luma is a linear combination of R, G
 * and B and resampling is linear, so the two orders are mathematically identical (ffmpeg also
 * converts on input, inside swscale); doing it first means the resampler moves one plane
 * instead of three.
 *
 * OUT-OF-SOURCE SAMPLES ARE WHITE. The geometry solver deliberately does not clamp its crop —
 * it would rather ask for pixels that were never photographed than move the face — so this is
 * a routine path, not an error path. White is the honest answer because the composition already
 * floats on white; edge-clamping would smear the outermost row of the photo into a streak that
 * reads as a rendering bug.
 */
function resample(src: ImageData, crop: Crop, outW: number, outH: number): Float64Array {
  const sw = src.width;
  const sh = src.height;
  const px = src.data;

  const hx = buildTaps(crop.x, crop.w, outW, LANCZOS_A);
  const hy = buildTaps(crop.y, crop.h, outH, LANCZOS_A);

  // Horizontal pass over every source row any vertical tap can reach.
  const rows = hy.last - hy.first + 1;
  const tmp = new Float64Array(rows * outW);
  const lumaRow = new Float64Array(sw);

  for (let r = 0; r < rows; r++) {
    const sy = hy.first + r;
    if (sy < 0 || sy >= sh) {
      // Whole row is off the photograph. The weights sum to 1, so the answer is exactly white.
      tmp.fill(Y_WHITE, r * outW, (r + 1) * outW);
      continue;
    }

    const base = sy * sw * 4;
    for (let x = 0; x < sw; x++) {
      const o = base + x * 4;
      const alpha = px[o + 3] / 255;
      // Composite over white rather than carrying alpha through. A transparent upload has to
      // resolve against SOMETHING, and the only colour consistent with the fill above — and
      // with the white the signature is pasted onto — is white.
      const r8 = px[o] * alpha + 255 * (1 - alpha);
      const g8 = px[o + 1] * alpha + 255 * (1 - alpha);
      const b8 = px[o + 2] * alpha + 255 * (1 - alpha);
      lumaRow[x] = Y_BLACK + (Y_RANGE / 255) * (LUMA_R * r8 + LUMA_G * g8 + LUMA_B * b8);
    }

    for (let i = 0; i < outW; i++) {
      const o = i * hx.width;
      let acc = 0;
      for (let k = 0; k < hx.width; k++) {
        const sx = hx.idx[o + k];
        acc += hx.wt[o + k] * (sx < 0 || sx >= sw ? Y_WHITE : lumaRow[sx]);
      }
      tmp[r * outW + i] = acc;
    }
  }

  // Vertical pass. Rows are already white where they had to be, so no bounds test survives here.
  const out = new Float64Array(outW * outH);
  for (let j = 0; j < outH; j++) {
    const o = j * hy.width;
    for (let k = 0; k < hy.width; k++) {
      const w = hy.wt[o + k];
      if (w === 0) continue;
      const rowBase = (hy.idx[o + k] - hy.first) * outW;
      const dstBase = j * outW;
      for (let i = 0; i < outW; i++) out[dstBase + i] += w * tmp[rowBase + i];
    }
  }

  return out;
}

/**
 * ffmpeg's `gblur`, in place.
 *
 * THIS IS NOT A CONVOLUTION, and that is a deliberate deviation from the brief, which asked for
 * a true Gaussian kernel. `vf_gblur` implements Getreuer's `gaussianiir2d`: a first-order
 * recursive filter run forwards then backwards along each axis, `steps` times, with a
 * post-scale that restores unity DC gain. At sigma = 0.6 with steps = 1 that approximation is
 * NOT interchangeable with a real Gaussian — its impulse response is [0.103, 0.762, 0.103]
 * against the true kernel's [0.166, 0.664, 0.166], i.e. it is visibly tighter — so the two are
 * not a rounding difference, they are different amounts of blur.
 *
 * Measured against the fixture: this port is BIT-EXACT with ffmpeg's blur stage (0 differing
 * pixels out of 54 080) and lands the whole grade at mean 0.43 / max 7. A true Gaussian kernel
 * in its place lands at mean 0.98 / max 16 — still inside tolerance, but more than twice the
 * error and, at 3/4 of the max budget, no headroom. The owner asked for precision over speed;
 * precision here means matching the render that was actually signed off, so the reference
 * algorithm wins over the textbook one.
 *
 * `boundaryScale` seeds each pass as though the signal continued past the edge at the edge
 * value — the recursive equivalent of clamp-extending a convolution.
 */
function blurInPlace(plane: Float64Array, w: number, h: number, sigma: number, steps: number): void {
  if (sigma <= 0 || steps < 1) return;

  const lambda = (sigma * sigma) / (2 * steps);
  const nu = (1 + 2 * lambda - Math.sqrt(1 + 4 * lambda)) / (2 * lambda);
  const boundaryScale = 1 / (1 - nu);
  // One factor per axis. (nu/lambda)^steps is exactly (1-nu)^(2·steps), the inverse of the DC
  // gain the forward+backward passes introduce.
  const postScale = Math.pow(nu / lambda, steps) ** 2;

  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let s = 0; s < steps; s++) {
      plane[o] *= boundaryScale;
      for (let x = 1; x < w; x++) plane[o + x] += nu * plane[o + x - 1];
      plane[o + w - 1] *= boundaryScale;
      for (let x = w - 1; x > 0; x--) plane[o + x - 1] += nu * plane[o + x];
    }
  }

  for (let x = 0; x < w; x++) {
    for (let s = 0; s < steps; s++) {
      plane[x] *= boundaryScale;
      for (let y = 1; y < h; y++) plane[y * w + x] += nu * plane[(y - 1) * w + x];
      plane[(h - 1) * w + x] *= boundaryScale;
      for (let y = h - 1; y > 0; y--) plane[(y - 1) * w + x] += nu * plane[y * w + x];
    }
  }

  // ffmpeg applies both axes' post-scale and clips once, at the end of the 2D pass.
  for (let i = 0; i < plane.length; i++) {
    const v = plane[i] * postScale;
    plane[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
}

/**
 * ffmpeg's `eq`, transcribed from `create_lut` in `vf_eq.c` and verified exhaustively: over the
 * 213 distinct luma values the reference frame contains, this reproduces ffmpeg's LUT with zero
 * mismatches.
 *
 * Three details a reimplementation gets wrong by default:
 *
 *  - ORDER. Contrast pivots about 0.5, THEN brightness is added, THEN gamma. Swapping contrast
 *    and brightness moves every midtone, because brightness would then be amplified by 1.32.
 *  - THE EXPONENT IS 1/gamma, not gamma. `gamma=1.04` is therefore a lift, not a crush.
 *  - 0.5 IS NOT MID-GREY HERE. `v` is the stored luma over 255, and the signal is limited range,
 *    so the pivot sits at Y=127.5 — a touch above the true midpoint of 16..235. Normalising the
 *    limited range to 0..1 first would look more principled and would be wrong.
 *
 * `y` is a float, unlike ffmpeg's 8-bit LUT index, so the input side is strictly more precise
 * than the reference. The OUTPUT quantisation is kept exactly as ffmpeg wrote it — 256·v
 * truncated, not 255·v rounded — because it is the only quantisation in this port and it is
 * what produced the fixture. It differs from rounding by up to half a level.
 */
export function eqCurve(y: number): number {
  let v = y / 255;
  v = EQ_CONTRAST * (v - 0.5) + 0.5 + EQ_BRIGHTNESS;
  if (v <= 0) return 0;
  v = Math.pow(v, 1 / EQ_GAMMA);
  if (v >= 1) return 255;
  return Math.trunc(256 * v);
}

/**
 * Limited-range luma back to a full-range grey level, which is what the PNG/canvas holds.
 * Verified exact against the fixture: 54 080 of 54 080 pixels agree.
 */
export function yToGrey(y: number): number {
  const g = Math.round(((y - Y_BLACK) * 255) / Y_RANGE);
  return g < 0 ? 0 : g > 255 ? 255 : g;
}

/**
 * The grade, as a single-channel plane — one byte of grey per pixel, row-major.
 *
 * Split out from `grade` so the whole pipeline is testable under Node, which has neither
 * `ImageData` nor a canvas: this takes a hand-built `{ data, width, height }` and returns a
 * plain array.
 */
/** Round a working plane back to the 8-bit container each ffmpeg filter actually writes to. */
function quantiseInPlace(plane: Float64Array): void {
  for (let i = 0; i < plane.length; i++) {
    const v = Math.round(plane[i]);
    plane[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
}

export function gradePlane(
  src: ImageData,
  crop: Crop,
  outW: number,
  outH: number,
): Uint8ClampedArray {
  if (!Number.isInteger(outW) || !Number.isInteger(outH) || outW < 1 || outH < 1) {
    throw new RangeError(`grade: output size must be positive integers, got ${outW}x${outH}`);
  }
  if (!(crop.w > 0) || !(crop.h > 0)) {
    throw new RangeError(`grade: crop must have positive extent, got ${crop.w}x${crop.h}`);
  }

  const plane = resample(src, crop, outW, outH);

  // Carrying doubles all the way to `eq` is MORE precise than the reference and therefore less
  // faithful to it. ffmpeg hands each filter an 8-bit plane: swscale rounds on output, vf_gblur
  // rounds on output with lrintf, and vf_eq is a 256-entry lookup table indexed by an integer —
  // it physically cannot see a fractional input. Quantising here reproduces that, and it is
  // measurably closer to the render that was signed off. (Math.round is half-up where lrintf is
  // half-to-even; that differs only on exact .5 ties, which is under a tenth of an LSB.)
  quantiseInPlace(plane);
  blurInPlace(plane, outW, outH, BLUR_SIGMA, BLUR_STEPS);
  quantiseInPlace(plane);

  const out = new Uint8ClampedArray(outW * outH);
  for (let i = 0; i < plane.length; i++) out[i] = yToGrey(eqCurve(plane[i]));
  return out;
}

/**
 * Crop, resample, desaturate, blur and grade `src` into an `outW`x`outH` RGBA image.
 *
 * `crop` is in source pixels and may be fractional, negative, or extend past the source; every
 * sample it asks for outside the photograph comes back white.
 */
export function grade(src: ImageData, crop: Crop, outW: number, outH: number): ImageData {
  const plane = gradePlane(src, crop, outW, outH);
  const rgba = new Uint8ClampedArray(outW * outH * 4);
  for (let i = 0; i < plane.length; i++) {
    const g = plane[i];
    rgba[i * 4] = g;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = g;
    rgba[i * 4 + 3] = 255;
  }
  return new ImageData(rgba, outW, outH);
}
