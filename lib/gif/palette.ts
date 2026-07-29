/**
 * Palette construction and quantisation — the half of the encoder that decides what the GIF
 * LOOKS like. The muxer only decides what it weighs.
 *
 * This reproduces, in the browser, the two ffmpeg passes the reference pipeline used:
 *
 *   palettegen=stats_mode=diff:max_colors=24     ->  buildPalette({ statsMode: "diff" })
 *   paletteuse=dither=bayer:bayer_scale=3        ->  createQuantizer(..., "bayer", 3)
 *
 * THE ONE BUG THIS FILE EXISTS TO PREVENT: with stats_mode=diff the reference once quantised
 * pure white to rgb(250,254,255). Invisible on a monitor, ruinous in an inbox — the signature
 * became a faint grey rectangle sitting on Gmail's white body. ffmpeg's answer was to switch
 * to stats_mode=full and hope white stayed dominant enough to win a palette slot. That is a
 * hope, not a guarantee: it depends on how much of the frame is white.
 *
 * Here white is RESERVED instead. If any pixel in any frame is exactly 255/255/255, one
 * palette entry is pinned to exactly 255/255/255 before quantisation runs, and every pure
 * white pixel is mapped straight to it — bypassing the dither, which would otherwise nudge a
 * white pixel to 251 and reintroduce the same grey by a different route. Reserving costs one
 * of the 24 entries; the guarantee is worth more than the entry.
 *
 * Because white is pinned, `statsMode` becomes a pure quality knob rather than a correctness
 * one, and "diff" — which spends the remaining entries on the pixels that actually move — is
 * the better default for both clips.
 */

/**
 * The pixel container. Deliberately structural rather than `ImageData`: Node has no canvas,
 * so the tests hand-build these, and a real `ImageData` still satisfies it.
 */
export type Frame = Pick<ImageData, "width" | "height" | "data">;

/** Where the palette's colour budget is spent. Mirrors ffmpeg's palettegen `stats_mode`. */
export type StatsMode = "diff" | "full";

export type DitherMode = "bayer" | "none";

export interface Palette {
  /** Packed triples: entry i is rgb[3i], rgb[3i+1], rgb[3i+2]. */
  readonly rgb: Uint8Array;
  readonly size: number;
  /** Index of the exact 255/255/255 entry, or -1 when no frame contains pure white. */
  readonly whiteIndex: number;
}

const WHITE = 0xffffff;

/* ------------------------------------------------------------------ ordered dither ------ */

/**
 * The classic 8x8 Bayer matrix, values 0..63, built from the recurrence
 *   M(2n) = [[4M, 4M+2], [4M+3, 4M+1]]
 * rather than typed out, so it cannot be mistyped. The literal matrix is asserted in the
 * tests — this is the one place where generating and checking are both worth doing.
 */
/**
 * ffmpeg's own Bayer matrix, transcribed from `dither_value()` in libavfilter/vf_paletteuse.c
 * rather than re-derived, and indexed the way that file indexes it: `(y & 7) << 3 | (x & 7)`.
 *
 * This was the textbook recursive construction until it was checked cell by cell against the
 * source: the two agree on 8 of 64 cells — the diagonal — and agree on all 64 once one is
 * transposed. The textbook matrix is the TRANSPOSE of ffmpeg's, so the crosshatch leaned the
 * wrong way and half the pixels picked the other side of their quantisation boundary. Both are
 * legitimate Bayer matrices; only one reproduces the render that was signed off.
 *
 * Carrying ffmpeg's bit-twiddling verbatim, opaque as it is, is the point: a second derivation
 * is a second chance to be subtly wrong about the same thing.
 */
export const BAYER8: Uint8Array = (() => {
  const out = new Uint8Array(64);
  for (let p = 0; p < 64; p += 1) {
    const q = p ^ (p >> 3);
    out[p] =
      ((p & 4) >> 2) |
      ((q & 4) >> 1) |
      ((p & 2) << 1) |
      ((q & 2) << 2) |
      ((p & 1) << 4) |
      ((q & 1) << 5);
  }
  return out;
})();

/**
 * ffmpeg's paletteuse turns the matrix into a SIGNED perturbation:
 *   offset = (bayer >> bayer_scale) - (1 << (5 - bayer_scale))
 * so it barely shifts the image's overall luma (its mean is -0.5, not 0 — that asymmetry is
 * ffmpeg's, and it is reproduced rather than corrected, because matching the reference render
 * matters more than being tidy). At the reference's bayer_scale=3 the range is [-4, +3]: enough
 * to break up banding on a face, small enough to leave flat areas flat.
 */
export function bayerOffsets(bayerScale: number): Int8Array {
  if (!Number.isInteger(bayerScale) || bayerScale < 0 || bayerScale > 5) {
    throw new RangeError(`bayerScale must be an integer in 0..5, got ${bayerScale}`);
  }
  const bias = 1 << (5 - bayerScale);
  const out = new Int8Array(64);
  for (let i = 0; i < 64; i += 1) out[i] = (BAYER8[i] >> bayerScale) - bias;
  return out;
}

/* ------------------------------------------------------------------------ histogram ------ */

/**
 * Composite onto white and pack into 24 bits.
 *
 * The frames these GIFs are built from are opaque, but an OffscreenCanvas that was never
 * explicitly filled hands back alpha 0 in untouched regions. Compositing onto white is the
 * only interpretation consistent with the rest of the design (the whole composition floats on
 * a white mail body), and it means a partially-transparent frame degrades into the right
 * picture instead of into black.
 */
function packOverWhite(r: number, g: number, b: number, a: number): number {
  if (a === 255) return (r << 16) | (g << 8) | b;
  const rr = 255 - Math.round(((255 - r) * a) / 255);
  const gg = 255 - Math.round(((255 - g) * a) / 255);
  const bb = 255 - Math.round(((255 - b) * a) / 255);
  return (rr << 16) | (gg << 8) | bb;
}

interface Entry {
  r: number;
  g: number;
  b: number;
  w: number;
}

/**
 * A colour histogram over every frame.
 *
 * `diff` counts a pixel only when it differs from the same pixel in the previous frame, which
 * is what biases the palette toward the parts of the loop that move. The first frame is always
 * counted in full — there is nothing to diff it against, and it is also the only frame Outlook
 * will ever show, so it deserves the weight.
 *
 * `hasWhite` is scanned unconditionally, NOT from the histogram: in diff mode a static white
 * background never enters the histogram at all, and that is precisely the case where the
 * reserved white entry matters most.
 */
function histogram(
  frames: readonly Frame[],
  statsMode: StatsMode,
): { entries: Entry[]; hasWhite: boolean } {
  const hist = new Map<number, number>();
  let hasWhite = false;
  let prev: Frame["data"] | null = null;

  for (const f of frames) {
    const d = f.data;
    const diff = statsMode === "diff" && prev !== null;
    for (let p = 0; p < d.length; p += 4) {
      const c = packOverWhite(d[p], d[p + 1], d[p + 2], d[p + 3]);
      if (c === WHITE) hasWhite = true;
      if (diff) {
        const q = packOverWhite(prev![p], prev![p + 1], prev![p + 2], prev![p + 3]);
        if (q === c) continue;
      }
      hist.set(c, (hist.get(c) ?? 0) + 1);
    }
    prev = d;
  }

  const entries: Entry[] = [];
  for (const [c, w] of hist) {
    entries.push({ r: (c >> 16) & 0xff, g: (c >> 8) & 0xff, b: c & 0xff, w });
  }
  return { entries, hasWhite };
}

/* ---------------------------------------------------------------------- median cut ------- */

interface Box {
  /** Half-open range into the shared entry array. */
  start: number;
  end: number;
  weight: number;
  mean: [number, number, number];
  /** Channel with the largest weighted variance — the one worth splitting on. */
  axis: 0 | 1 | 2;
  /** That variance. Boxes are split highest-first, exactly as ffmpeg's palettegen does. */
  score: number;
}

const CHANNEL = ["r", "g", "b"] as const;

function measure(entries: readonly Entry[], start: number, end: number): Box {
  let weight = 0;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let i = start; i < end; i += 1) {
    const e = entries[i];
    weight += e.w;
    sr += e.w * e.r;
    sg += e.w * e.g;
    sb += e.w * e.b;
  }
  const mean: [number, number, number] =
    weight > 0 ? [sr / weight, sg / weight, sb / weight] : [0, 0, 0];

  const v: [number, number, number] = [0, 0, 0];
  for (let i = start; i < end; i += 1) {
    const e = entries[i];
    v[0] += e.w * (e.r - mean[0]) ** 2;
    v[1] += e.w * (e.g - mean[1]) ** 2;
    v[2] += e.w * (e.b - mean[2]) ** 2;
  }
  let axis: 0 | 1 | 2 = 0;
  if (v[1] > v[axis]) axis = 1;
  if (v[2] > v[axis]) axis = 2;

  return { start, end, weight, mean, axis, score: v[axis] };
}

/**
 * Weighted median cut, split-worst-first — the same shape as ffmpeg's palettegen.
 *
 * Splitting on the widest-VARIANCE channel rather than the widest RANGE is the detail that
 * matters for a near-greyscale photograph: a handful of stray coloured pixels give a channel a
 * wide range while contributing almost nothing to how the image reads, and a range-based split
 * spends entries on them.
 */
function medianCut(entries: Entry[], target: number): Entry[] {
  if (entries.length === 0 || target <= 0) return [];

  const boxes: Box[] = [measure(entries, 0, entries.length)];

  while (boxes.length < target) {
    // Pick the worst-represented splittable box.
    let pick = -1;
    for (let i = 0; i < boxes.length; i += 1) {
      const b = boxes[i];
      if (b.end - b.start < 2 || b.score <= 0) continue;
      if (pick < 0 || b.score > boxes[pick].score) pick = i;
    }
    if (pick < 0) break; // every box is a single colour: the palette is already exact

    const box = boxes[pick];
    const key = CHANNEL[box.axis];
    // Sorting only the box's own range keeps the total work near n log n even at 24 splits.
    const seg = entries.slice(box.start, box.end).sort((a, b) => a[key] - b[key]);
    for (let i = 0; i < seg.length; i += 1) entries[box.start + i] = seg[i];

    let acc = 0;
    let split = box.start + 1;
    for (let i = box.start; i < box.end; i += 1) {
      acc += entries[i].w;
      split = i + 1;
      if (acc * 2 >= box.weight) break;
    }
    // Both halves must be non-empty, which the weighted median does not guarantee when one
    // colour carries more than half the weight.
    if (split <= box.start) split = box.start + 1;
    if (split >= box.end) split = box.end - 1;

    boxes[pick] = measure(entries, box.start, split);
    boxes.push(measure(entries, split, box.end));
  }

  return boxes.map((b) => ({
    r: Math.round(b.mean[0]),
    g: Math.round(b.mean[1]),
    b: Math.round(b.mean[2]),
    w: b.weight,
  }));
}

/* ------------------------------------------------------------------------ the palette ---- */

export interface BuildPaletteOptions {
  maxColors: number;
  statsMode: StatsMode;
}

export function buildPalette(frames: readonly Frame[], opts: BuildPaletteOptions): Palette {
  const { maxColors, statsMode } = opts;
  if (!Number.isInteger(maxColors) || maxColors < 2 || maxColors > 255) {
    // 255 rather than 256: the muxer needs one spare slot in the colour table for its
    // transparent index, and that slot must exist without stealing a real colour.
    throw new RangeError(`maxColors must be an integer in 2..255, got ${maxColors}`);
  }

  const { entries, hasWhite } = histogram(frames, statsMode);
  const isWhite = (e: Entry) => e.r === 255 && e.g === 255 && e.b === 255;
  const rest = hasWhite ? entries.filter((e) => !isWhite(e)) : entries;

  const quantised = medianCut(rest, hasWhite ? maxColors - 1 : maxColors);

  // Dedupe: two boxes whose weighted means round to the same colour would otherwise burn an
  // entry on nothing. Sorted by luma purely so the palette is deterministic across runs —
  // tests compare palettes, and Map iteration order is an implementation detail of the input.
  const packed = new Set<number>();
  if (hasWhite) packed.add(WHITE);
  for (const c of quantised) packed.add((c.r << 16) | (c.g << 8) | c.b);

  const sorted = [...packed].sort((a, b) => luma(a) - luma(b) || a - b);
  const rgb = new Uint8Array(sorted.length * 3);
  let whiteIndex = -1;
  sorted.forEach((c, i) => {
    if (c === WHITE && hasWhite) whiteIndex = i;
    rgb[3 * i] = (c >> 16) & 0xff;
    rgb[3 * i + 1] = (c >> 8) & 0xff;
    rgb[3 * i + 2] = c & 0xff;
  });

  return { rgb, size: sorted.length, whiteIndex };
}

const luma = (c: number) =>
  0.299 * ((c >> 16) & 0xff) + 0.587 * ((c >> 8) & 0xff) + 0.114 * (c & 0xff);

/* ----------------------------------------------------------------------- quantisation ---- */

/**
 * Build the frame -> palette-index mapper.
 *
 * Returned as a closure so the nearest-colour cache and the dither table survive across all
 * 110 frames. The cache is what makes exhaustive nearest-colour search affordable: the search
 * itself is a linear scan in squared RGB distance (what ffmpeg's paletteuse does), which is
 * exact — no k-d tree approximations, no pre-quantisation of the query colour. Precision over
 * speed, deliberately: an approximate lookup that picks a different entry for the same colour
 * on two different frames would make the pixel "change" and defeat the sub-rectangle diffing
 * the whole file-size budget rests on.
 */
export function createQuantizer(
  palette: Palette,
  dither: DitherMode,
  bayerScale: number,
): (frame: Frame, out: Uint8Array) => void {
  const { rgb, size, whiteIndex } = palette;
  const offsets = dither === "bayer" ? bayerOffsets(bayerScale) : null;
  const cache = new Map<number, number>();

  const nearest = (r: number, g: number, b: number): number => {
    const key = (r << 16) | (g << 8) | b;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < size; i += 1) {
      const dr = r - rgb[3 * i];
      const dg = g - rgb[3 * i + 1];
      const db = b - rgb[3 * i + 2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        best = i;
        if (d === 0) break;
      }
    }
    cache.set(key, best);
    return best;
  };

  return (frame: Frame, out: Uint8Array): void => {
    const { width, height, data } = frame;
    if (out.length !== width * height) {
      throw new RangeError(`out must hold ${width * height} indices, got ${out.length}`);
    }
    let p = 0;
    let o = 0;
    for (let y = 0; y < height; y += 1) {
      const row = (y & 7) << 3;
      for (let x = 0; x < width; x += 1, p += 4, o += 1) {
        const c = packOverWhite(data[p], data[p + 1], data[p + 2], data[p + 3]);
        if (c === WHITE && whiteIndex >= 0) {
          // The whole point of the reserved entry. Never dithered: a +3 Bayer offset on white
          // clips back to white, but a -4 one lands on 251 and can select a near-white entry,
          // which is the grey-rectangle bug arriving through the dither instead of through the
          // palette.
          out[o] = whiteIndex;
          continue;
        }
        if (offsets) {
          const d = offsets[row | (x & 7)];
          out[o] = nearest(
            clamp8(((c >> 16) & 0xff) + d),
            clamp8(((c >> 8) & 0xff) + d),
            clamp8((c & 0xff) + d),
          );
        } else {
          out[o] = nearest((c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);
        }
      }
    }
  };
}

const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
