/**
 * Portrait geometry — the one piece of maths the whole product rests on.
 *
 * The reference implementation (jonathan-naal/videos) hand-tuned a crop until the face
 * happened to sit inside the band overlap. That took four attempts on ONE face, with the
 * ability to look at renders. A stranger cannot do it, so here the dependency is inverted:
 * the user declares where their face is, and the geometry is solved from it.
 *
 * WHAT THE USER DECLARES: two points, the EYE LINE and the CHIN.
 * Not "the top of your head" — that is genuinely ambiguous (crown? hairline? the hat?) and a
 * 50px error there decapitates the portrait while every internal check still passes. The eye
 * line and the chin are unmistakable, and a person places them in three seconds.
 *
 * WHY THE BAND MATHS COLLAPSES TO ONE PARAMETER: in the validated reference, WINDOW_H = 212,
 * REST = 24 and PHOTO_H = 260 — that is, WINDOW_H + 2·REST = PHOTO_H exactly. The high window
 * starts flush with the top of the photo and the low window ends flush with its bottom; the
 * windows tile the photo. That is not a coincidence to preserve by accident, so it is made
 * structural here: WINDOW_H is DERIVED as PHOTO_H − 2·REST, and REST is the only free number.
 *
 * The overlap of a high and a low window — the region every band shows, the region the face
 * must live in — is then simply [2·REST, PHOTO_H − 2·REST].
 */

/** Output frame. The photo is portrait 4:5; PAD is white margin so the staircase can breathe. */
export const PHOTO_W = 208;
export const PHOTO_H = 260;
export const PAD = 8;
export const CANVAS_W = PHOTO_W + 2 * PAD; // 224
export const CANVAS_H = PHOTO_H + 2 * PAD; // 276

export const ASPECT = PHOTO_W / PHOTO_H; // 0.8

/**
 * Where the reference landed the face, measured from build-portrait.sh and re-derived below
 * in `REFERENCE`. Framing every photo the same way is what makes one set of band constants
 * work for everyone.
 */
export const BROW_FRAC = 104 / PHOTO_H; // 0.400000 — eye line at 40% of the frame
export const BROW_CHIN = 66 / PHOTO_H; //  0.253846 — eye line → chin, as a fraction of the frame

/**
 * Forehead + hair reserved above the eye line, as a multiple of the eye-to-chin distance.
 * 48/66 in the reference. It is a proportion rather than a constant because it has to scale
 * with the face: a fixed pixel allowance would swallow a child's face and clip a tall one.
 * It is an ESTIMATE of where the hair starts — the positioner draws the safe zone so the user
 * sees the truth rather than trusting this number.
 */
export const HAIR_RATIO = 48 / 66; // 0.727273

/** Clearance kept between a band edge and the face. 8px in the reference. */
export const FACE_MARGIN = 8;

/**
 * How far the crop may hang off the edge of the source, as a fraction of the crop, before we
 * stop stretching. Overhang is filled with white by the grader.
 *
 * This exists because the ideal framing frequently wants pixels the photo does not have — a
 * head near the top of a tight profile picture needs headroom that was never photographed.
 * Refusing those outright would reject a large share of real uploads. Filling with white is
 * benign here specifically because the composition already floats on white: the bands simply
 * reveal less photograph. Past this limit it stops looking deliberate and starts looking
 * broken, so past this limit we clamp and let the REST solve decide whether it is salvageable.
 */
export const MAX_OVERHANG = 0.15;

/**
 * REST is the staircase depth. Too small and the effect disappears; too large and the overlap
 * cannot hold a face. The reference sits at 24.
 */
export const REST_MIN = 14;
export const REST_MAX = 30;

/** Band constants that do not depend on the face. Unchanged from the reference. */
export const BANDS = 5;
export const SLOPE = 0.175;
export const OVERFLOW = 52;
export const SPAN = (PHOTO_W + 2 * OVERFLOW) / BANDS; // 62.4
export const GAP = 2.5;

export interface SourceSize {
  w: number;
  h: number;
}

/** All three are fractions of the source image, 0..1. */
export interface Landmarks {
  /** Horizontal centre of the face. */
  faceCx: number;
  /** The eye line. */
  browY: number;
  /** The bottom of the chin. */
  chinY: number;
}

/** A crop rectangle in SOURCE pixels. */
export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BandGeometry {
  /** Staircase depth, and the derived window height. */
  rest: number;
  windowH: number;
  /** Resting top edge of a window that sits low / high, in photo pixels. */
  lowTop: number;
  highTop: number;
  /** The region every band shows — where the face has to be. */
  overlap: { top: number; bottom: number };
}

export type WarningCode =
  /** The crop hangs off the source; the grader fills the difference with white. */
  | "white-fill"
  /** Overhang hit its limit, so the face is no longer where the reference put it. */
  | "crop-clamped"
  /** No band geometry can clear this face. The caller must ask for another photo. */
  | "cannot-frame"
  | "landmarks-implausible";

export interface Solution {
  /**
   * In SOURCE pixels. May be negative, or extend past the source — the grader fills anything
   * outside the image with white. Do not clamp this; the framing depends on it.
   */
  crop: Crop;
  geom: BandGeometry;
  /** Where the face actually landed, in photo pixels — what the positioner draws. */
  placed: { hairTop: number; brow: number; chin: number };
  /** False when no geometry clears the face. Render the preview anyway, but block publish. */
  ok: boolean;
  warnings: WarningCode[];
}

const clamp = (lo: number, hi: number, v: number) => Math.min(hi, Math.max(lo, v));

/**
 * clamp() where the bounds may be inverted. That happens whenever the crop is wider or taller
 * than the source plus its overhang allowance — a tightly cropped headshot, which is one of
 * the most common uploads there is. Centring is the only meaningful answer; a plain clamp
 * would silently pin the crop to one edge and throw the framing off.
 */
const boundedClamp = (lo: number, hi: number, v: number) =>
  lo > hi ? (lo + hi) / 2 : clamp(lo, hi, v);

/**
 * Solve the crop and the band geometry from two declared landmarks.
 *
 * Two passes on purpose. The first sizes a crop that would place the face exactly where the
 * reference placed it. The second clamps that crop into the image — a face near an edge cannot
 * always be centred — and then RE-DERIVES where the landmarks really ended up, solving the
 * bands against reality rather than against the intention. Skipping that is how a photo with
 * the head near the top silently gets a band edge through the eyes.
 */
export function solve(src: SourceSize, lm: Landmarks): Solution {
  const warnings: WarningCode[] = [];

  const browPx = lm.browY * src.h;
  const chinPx = lm.chinY * src.h;
  const facePx = chinPx - browPx;

  if (facePx <= 0) {
    // The chin was placed above the eye line, or the two coincide. Nothing sensible can be
    // solved, so fall back to a plausible default framing purely so the preview keeps
    // rendering, and flag it — the caller re-prompts rather than letting this be published.
    const fallback = solve(src, { faceCx: 0.5, browY: 0.32, chinY: 0.46 });
    return { ...fallback, ok: false, warnings: [...fallback.warnings, "landmarks-implausible"] };
  }

  // ---- Pass 1: the crop that reproduces the reference framing --------------------------
  // Deliberately NOT clamped into the image. Normalising every photo to the same framing is
  // precisely what lets one band geometry work for every face; clamping here is what broke it.
  let ch = facePx / BROW_CHIN;
  let cw = ASPECT * ch;

  // A crop larger than the source plus its white allowance means the face fills the photo and
  // the framing wants headroom that would have to be invented wholesale. Cap it here so the
  // overhang stays bounded; the REST solve below then either absorbs the tighter framing or
  // reports that this photograph cannot be used. Without the cap, a tight headshot produces a
  // crop twice the height of the source — a thumbnail-sized face adrift in white.
  const maxW = src.w * (1 + 2 * MAX_OVERHANG);
  const maxH = src.h * (1 + 2 * MAX_OVERHANG);
  if (cw > maxW || ch > maxH) {
    const k = Math.min(maxW / cw, maxH / ch);
    cw *= k;
    ch *= k;
  }

  const idealY = browPx - BROW_FRAC * ch;
  const idealX = lm.faceCx * src.w - cw / 2;

  // ---- Pass 2: allow overhang up to the limit, then clamp ------------------------------
  const overX = MAX_OVERHANG * cw;
  const overY = MAX_OVERHANG * ch;
  // When the crop is larger than the source plus its allowance the bounds invert; centring is
  // the only meaningful answer, and it happens on tightly cropped headshots, which are common.
  const cx = boundedClamp(-overX, src.w - cw + overX, idealX);
  const cy = boundedClamp(-overY, src.h - ch + overY, idealY);

  if (cx < 0 || cy < 0 || cx + cw > src.w || cy + ch > src.h) warnings.push("white-fill");
  if (Math.abs(cx - idealX) > 0.5 || Math.abs(cy - idealY) > 0.5) warnings.push("crop-clamped");

  // Left as exact floats. The reference had to round because ffmpeg's crop filter takes
  // integers, and that rounding is what shifted the eye line by 0.02px and made floor() below
  // return 23 instead of the validated 24. drawImage takes floats, so the drift is simply
  // not created here.
  const crop: Crop = { x: cx, y: cy, w: cw, h: ch };

  // ---- Where the landmarks actually landed, in photo pixels -----------------------------
  const k = PHOTO_H / crop.h;
  const brow = (browPx - crop.y) * k;
  const chin = (chinPx - crop.y) * k;
  const hairTop = brow - HAIR_RATIO * (chin - brow);

  // ---- Solve REST ------------------------------------------------------------------------
  // The face must sit inside [2·REST, PHOTO_H − 2·REST] with FACE_MARGIN of clearance, so:
  //     2·REST ≤ hairTop − margin        and        PHOTO_H − 2·REST ≥ chin + margin
  // Take the tighter of the two and keep the deepest staircase that still clears the face.
  const restForTop = (hairTop - FACE_MARGIN) / 2;
  const restForBottom = (PHOTO_H - chin - FACE_MARGIN) / 2;
  const ideal = Math.floor(Math.min(restForTop, restForBottom));

  // Below REST_MIN there is no staircase left to give up: the face genuinely does not fit any
  // band geometry, and the only honest answer is to ask for a different photo. Normal uploads
  // never reach here — the ideal framing yields exactly 24, the reference value.
  const ok = ideal >= REST_MIN;
  if (!ok) warnings.push("cannot-frame");

  const rest = clamp(REST_MIN, REST_MAX, ideal);
  const windowH = PHOTO_H - 2 * rest;

  return {
    crop,
    ok,
    geom: {
      rest,
      windowH,
      // A window that rests low starts at 2·REST; one that rests high starts at 0. Both are
      // WINDOW_H tall, so the low one ends flush with the bottom of the photo.
      lowTop: 2 * rest,
      highTop: 0,
      overlap: { top: 2 * rest, bottom: PHOTO_H - 2 * rest },
    },
    placed: { hairTop, brow, chin },
    warnings,
  };
}

/**
 * The reference photo, measured in build-portrait.sh. Kept in code so the test suite asserts
 * against the numbers that were actually validated by eye, not against a re-derivation.
 */
export const REFERENCE = {
  source: { w: 1080, h: 1620 },
  landmarks: { faceCx: 580 / 1080, browY: 480 / 1620, chinY: 720 / 1620 },
  expectedCrop: { x: 202, y: 102, w: 756, h: 945 },
  expectedRest: 24,
  expectedWindowH: 212,
} as const;
