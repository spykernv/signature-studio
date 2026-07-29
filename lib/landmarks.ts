/**
 * Automatic landmark placement — it finds the two points lib/geometry.ts solves the portrait
 * from, so the user usually does not have to.
 *
 * The decision this module encodes: MediaPipe places the points, nothing else. No LLM call, no
 * upload. The photograph never leaves the device, which is not a nice-to-have — a stranger's
 * face is the single most sensitive thing this product will ever touch, and the only way to
 * promise it stays local is to never have a network path for it.
 *
 * This is a HINT, never an authority. `geometry.solve()` is unforgiving: a mistaken chin shifts
 * the crop scale, which moves the hairline, which is how a band edge ends up drawn across
 * someone's face. So every reason to doubt a detection is converted into a confidence score,
 * and anything doubtful returns `landmarks: null` and lets the user place the two points by
 * hand. It never throws: the manual positioner is the fallback for every failure path, so a
 * failure here is a shrug, not an error.
 *
 * ─── WHAT `browY` ACTUALLY IS ────────────────────────────────────────────────────────────────
 * `Landmarks.browY` is documented in geometry.ts as "the eye line", and the obvious reading is
 * the pupils. It is NOT the pupils, and getting this wrong slices hair off the top of the head.
 *
 * The reference (jonathan-naal/videos/scripts/build-portrait.sh) states the three measurements
 * the whole geometry is calibrated from: "hairline y=306, eyebrows y=480, chin y=720" in the
 * 1080x1620 source. Those numbers give HAIR_RATIO = (480−306)/(720−480) = 174/240 = 0.725,
 * which is exactly geometry.ts's 48/66. So HAIR_RATIO is calibrated against the EYEBROWS.
 *
 * Measured on test/fixtures/source-portrait.png (rulers drawn with ffmpeg, read off the image):
 * y=480 sits at the lower edge of the eyebrows; the pupils are at y≈517. That is 37px, 15% of
 * the 240px brow-to-chin distance. Feeding the pupil line in instead would make geometry.ts
 * predict a hairline ~11px lower in the 260px photo than the real one, i.e. it would report
 * 8px of clearance under the band edge while the actual hair sat 3px above it. Sliced crown —
 * the exact defect geometry.ts exists to prevent, reported as a success.
 *
 * So `browY` here is the LOWER EDGE OF THE EYEBROWS, which reproduces the validated reference.
 * The pupil line is still computed and returned in `detail.pupilY`, because the manual
 * positioner has to draw a handle the user understands, and because someone will check.
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Runs in a Web Worker: no window, no document. The only DOM type touched is ImageBitmap
 * (transferable) and OffscreenCanvas (which MediaPipe binds its GL context to).
 */

import type { Landmarks } from "./geometry";

/** Re-exported so callers get the one definition, from geometry.ts, wherever they import it. */
export type { Landmarks };

/** A landmark. MediaPipe's `NormalizedLandmark` (x, y, z, visibility) satisfies this. */
export interface Point {
  /** Fraction of image width. May fall outside 0..1 — the model extrapolates past the edge. */
  x: number;
  /** Fraction of image height. */
  y: number;
}

export type DetectFailure = "no-face" | "multiple-faces" | "low-confidence" | "unsupported";

/** Why a detection scored the way it did. Each is 0..1; the UI uses them to explain itself. */
export interface ConfidenceFactors {
  /** Landmarks that fell inside the frame. A chin off the bottom edge is an extrapolated chin. */
  inFrame: number;
  /** Face size relative to the image. Small faces land imprecisely and crop up badly. */
  size: number;
  /** Head roll. The crop is axis-aligned, so a tilted head makes "the chin line" a fiction. */
  roll: number;
  /** Head yaw, from how far the eyes sit off the centre of the face oval. */
  yaw: number;
  /** Brow-to-chin against eye separation. Catches pitch, and catches nonsense. */
  proportion: number;
}

/**
 * Everything the caller might want to show or reconcile, none of which the contract promises.
 * Optional and additive on purpose — `DetectResult` above it is the agreed shape.
 */
export interface DetectDetail {
  /** Faces the model returned, before background faces were filtered out. */
  facesDetected: number;
  /**
   * The best candidate EVEN WHEN IT WAS REJECTED. A rejected guess is still a far better
   * starting position for the manual handles than the middle of the photo.
   */
  candidate: Landmarks | null;
  /** The pupil line — NOT what `browY` is. See the header. Null if the model gave no irises. */
  pupilY: number | null;
  /** Head roll in degrees, positive when the right of the image is lower. */
  rollDeg: number;
  factors: ConfidenceFactors;
}

export interface DetectResult {
  landmarks: Landmarks | null;
  confidence: number;
  /** More than one face is a real case and must be reported, not silently resolved. */
  faces: number;
  reason?: DetectFailure;
  detail?: DetectDetail;
}

/** The slice of MediaPipe's `FaceLandmarker` this module uses. */
export interface FaceLandmarkerLike {
  detect(image: ImageBitmap): { faceLandmarks: readonly (readonly Point[])[] };
  close?(): void;
}

/**
 * Injected rather than imported. Two reasons: the model plus WASM is ~15 MB that must never be
 * pulled into a unit test, and the app cannot afford to load it until a photo actually arrives.
 */
export type LandmarkerLoader = () => Promise<FaceLandmarkerLike>;

export interface DetectOptions {
  loadLandmarker?: LandmarkerLoader;
  /** Below this, the detection is discarded and the user places the points. */
  minConfidence?: number;
  /** Guards a wedged or blocked asset fetch. Only covers loading; `detect` itself is sync. */
  timeoutMs?: number;
}

// ─── Landmark indices ────────────────────────────────────────────────────────────────────────
// Extracted from the shipped bundle, not from memory:
//   node -e "const F=require('@mediapipe/tasks-vision').FaceLandmarker;
//            console.log(JSON.stringify(F.FACE_LANDMARKS_FACE_OVAL.map(c=>[c.start,c.end])))"
// Re-run that against a new @mediapipe/tasks-vision before trusting these after an upgrade.

/** The 36 points of the face oval. The chin is the lowest of them — see `landmarksFrom`. */
const FACE_OVAL = [
  10, 21, 54, 58, 67, 93, 103, 109, 127, 132, 136, 148, 149, 150, 152, 162, 172, 176, 234, 251,
  284, 288, 297, 323, 332, 338, 356, 361, 365, 377, 378, 379, 389, 397, 400, 454,
] as const;

/**
 * Each eyebrow is two polylines — one above the brow hair, one below it. Which is which is not
 * asserted here; `landmarksFrom` takes whichever row is lower on the day. That removes the one
 * thing in this file that would otherwise rest on recollection, and it survives a model update
 * that renumbers the rows.
 */
const BROW_ROWS: readonly (readonly (readonly number[])[])[] = [
  // Image-left brow (the subject's right).
  [
    [46, 53, 52, 65, 55],
    [70, 63, 105, 66, 107],
  ],
  // Image-right brow.
  [
    [276, 283, 282, 295, 285],
    [300, 293, 334, 296, 336],
  ],
];

/** The two eyelid rings. Their centroids are the eye centres. */
const EYE_RINGS: readonly (readonly number[])[] = [
  [33, 7, 163, 144, 145, 153, 154, 155, 133, 246, 161, 160, 159, 158, 157, 173],
  [263, 249, 390, 373, 374, 380, 381, 382, 362, 466, 388, 387, 386, 385, 384, 398],
];

/**
 * The iris rings, present only on the refined 478-point output. Their centroids are the pupils.
 * (The model also emits explicit centres at 468 and 473 — the ring centroid is the same point
 * and needs no assumption about which index is the centre.)
 */
const IRIS_RINGS: readonly (readonly number[])[] = [
  [469, 470, 471, 472],
  [474, 475, 476, 477],
];

/** face_landmarker.task emits 478 (468 mesh + 10 iris). Anything below 468 is not a face mesh. */
const BASE_LANDMARK_COUNT = 468;

// ─── Tunables ────────────────────────────────────────────────────────────────────────────────

export const MIN_CONFIDENCE = 0.5;

/**
 * A second face smaller than this fraction of the largest is a bystander, a poster or a
 * reflection, not a second subject. Without it, any photo with a person in the background
 * refuses to auto-place — and "we found two faces, which is you?" on a portrait with a blurred
 * pedestrian in it is a worse product than quietly using the obvious one.
 */
const BACKGROUND_FACE_RATIO = 0.4;

/** Face height (brow→chin) as a fraction of image height: no credit below, full credit above. */
const SIZE_MIN = 0.02;
const SIZE_GOOD = 0.08;

/** Head roll in degrees: free below the first, worthless above the second. */
const ROLL_FREE = 8;
const ROLL_BAD = 30;

/** Eye midpoint off the oval's horizontal centre, as a fraction of the oval half-width. */
const YAW_FREE = 0.15;
const YAW_BAD = 0.45;

/**
 * (brow→chin) / (eye separation), in pixels. The reference portrait measures 240/115 = 2.09.
 * The band is wide because real faces vary; it is here to catch pitch and gross nonsense, not
 * to have an opinion about anyone's face.
 */
const PROPORTION_GOOD: readonly [number, number] = [1.5, 2.9];
const PROPORTION_BAD: readonly [number, number] = [1.0, 3.6];

const DEFAULT_TIMEOUT_MS = 15_000;

// ─── Pure geometry over the landmark array ───────────────────────────────────────────────────

interface Pt {
  x: number;
  y: number;
}

const finite = (n: number) => Number.isFinite(n);

/** Null unless every index exists and carries finite coordinates — no partial faces. */
function pick(points: readonly Point[], indices: readonly number[]): Pt[] | null {
  const out: Pt[] = [];
  for (const i of indices) {
    const p = points[i];
    if (!p || !finite(p.x) || !finite(p.y)) return null;
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

function centroid(pts: readonly Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

const meanY = (pts: readonly Pt[]) => centroid(pts).y;

/** Linear ramp, clamped: 0 at `zero`, 1 at `one`. Works in either direction. */
function ramp(zero: number, one: number, v: number): number {
  if (zero === one) return v >= one ? 1 : 0;
  const t = (v - zero) / (one - zero);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** 1 inside `good`, falling to 0 at `bad`. */
function band(good: readonly [number, number], bad: readonly [number, number], v: number): number {
  if (v < good[0]) return ramp(bad[0], good[0], v);
  if (v > good[1]) return ramp(bad[1], good[1], v);
  return 1;
}

/** The eye centres, image-left first. Eyelid rings, not irises — see `landmarksFrom`. */
function eyeCentres(points: readonly Point[]): [Pt, Pt] | null {
  const rings = EYE_RINGS.map((r) => pick(points, r));
  if (rings.some((r) => r === null)) return null;
  const centres = (rings as Pt[][]).map(centroid);
  centres.sort((a, b) => a.x - b.x);
  return [centres[0], centres[1]];
}

/** The pupil line, or null when the model returned no iris landmarks. Diagnostic only. */
function pupilLine(points: readonly Point[]): number | null {
  const rings = IRIS_RINGS.map((r) => pick(points, r));
  if (rings.some((r) => r === null)) return null;
  const centres = (rings as Pt[][]).map(centroid);
  return (centres[0].y + centres[1].y) / 2;
}

/**
 * The conversion the whole module exists for: 478 mesh points → the three numbers geometry.ts
 * consumes. Pure, so it is the part that is actually unit-tested.
 *
 *   browY  — mean of the LOWER row of each eyebrow, averaged over both brows. The lower row is
 *            chosen by measurement, not by index (see BROW_ROWS). Averaging the two brows makes
 *            the value the height of the brow line at the centre of the face, which is what an
 *            axis-aligned crop needs, and cancels head roll to first order.
 *
 *   chinY  — the LOWEST point of the face oval, not index 152. On an upright face they are the
 *            same point. On a rolled head the lowest point is a jaw corner, which is exactly
 *            what must not be cut, and taking the maximum errs towards a looser crop. Erring
 *            the other way puts a band edge through a jaw.
 *
 *   faceCx — the midpoint of the two EYELID centroids, deliberately not the irises: the irises
 *            move with gaze and the frame must follow the head, not where the person is
 *            looking. A sideways glance is worth several pixels of horizontal drift.
 */
export function landmarksFrom(points: readonly Point[]): Landmarks | null {
  if (points.length < BASE_LANDMARK_COUNT) return null;

  const oval = pick(points, FACE_OVAL);
  const eyes = eyeCentres(points);
  if (!oval || !eyes) return null;

  const browRows: number[] = [];
  for (const brow of BROW_ROWS) {
    const rows = brow.map((r) => pick(points, r));
    if (rows.some((r) => r === null)) return null;
    // Larger y is lower in the image.
    browRows.push(Math.max(...(rows as Pt[][]).map(meanY)));
  }

  const browY = browRows.reduce((a, b) => a + b, 0) / browRows.length;
  const chinY = Math.max(...oval.map((p) => p.y));
  const faceCx = (eyes[0].x + eyes[1].x) / 2;

  if (!finite(browY) || !finite(chinY) || !finite(faceCx)) return null;
  return { faceCx, browY, chinY };
}

export interface FaceScore {
  landmarks: Landmarks;
  confidence: number;
  factors: ConfidenceFactors;
  pupilY: number | null;
  rollDeg: number;
  /** Brow-to-chin in pixels. Used only to rank candidate faces by size. */
  faceHeightPx: number;
}

/**
 * How much this detection deserves to be trusted.
 *
 * FaceLandmarker returns no score of its own — `FaceLandmarkerResult` is landmarks, optional
 * blendshapes and an optional transform matrix, nothing else — and its `visibility` field is
 * not populated for the face mesh. Whatever survives `minFaceDetectionConfidence` comes back
 * unlabelled. So confidence is reconstructed from the geometry: five independent ways for a
 * detection to be misleading, multiplied together.
 *
 * Multiplying rather than averaging is deliberate, and it is the precision-over-convenience
 * choice: any single one of these being badly wrong is enough to ruin the crop, and an average
 * lets four good factors hide one fatal one. The cost of being too strict is that the user
 * drags two handles, which they can do in three seconds.
 *
 * `size` is passed in because the landmarks are normalised: an angle computed in normalised
 * coordinates is skewed by the aspect ratio, and on a 2:3 portrait that inflates every roll by
 * half again.
 */
export function scoreFace(
  points: readonly Point[],
  size: { w: number; h: number },
): FaceScore | null {
  const landmarks = landmarksFrom(points);
  const eyes = eyeCentres(points);
  const oval = pick(points, FACE_OVAL);
  if (!landmarks || !eyes || !oval) return null;
  if (!(size.w > 0) || !(size.h > 0)) return null;

  const faceH = landmarks.chinY - landmarks.browY;
  // The chin above the eyebrows is not a face in any orientation this product supports.
  if (!(faceH > 0)) return null;

  const dx = (eyes[1].x - eyes[0].x) * size.w;
  const dy = (eyes[1].y - eyes[0].y) * size.h;
  const eyeGapPx = Math.hypot(dx, dy);
  if (!(eyeGapPx > 0)) return null;

  const rollDeg = (Math.atan2(dy, dx) * 180) / Math.PI;

  const xs = oval.map((p) => p.x);
  const ovalMinX = Math.min(...xs);
  const ovalMaxX = Math.max(...xs);
  const halfW = (ovalMaxX - ovalMinX) / 2;
  const eyeMidX = (eyes[0].x + eyes[1].x) / 2;
  const yawSkew = halfW > 0 ? Math.abs(eyeMidX - (ovalMinX + ovalMaxX) / 2) / halfW : 1;

  // Only the points that actually feed the crop are counted; a stray tesselation vertex off the
  // edge of the frame does not matter, an extrapolated chin does.
  const framed = [...oval, ...eyes];
  const inside = framed.filter((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1).length;

  const factors: ConfidenceFactors = {
    inFrame: inside / framed.length,
    size: ramp(SIZE_MIN, SIZE_GOOD, faceH),
    roll: 1 - ramp(ROLL_FREE, ROLL_BAD, Math.abs(rollDeg)),
    yaw: 1 - ramp(YAW_FREE, YAW_BAD, yawSkew),
    proportion: band(PROPORTION_GOOD, PROPORTION_BAD, (faceH * size.h) / eyeGapPx),
  };

  const confidence =
    factors.inFrame * factors.size * factors.roll * factors.yaw * factors.proportion;

  return {
    landmarks,
    confidence: finite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    factors,
    pupilY: pupilLine(points),
    rollDeg,
    faceHeightPx: faceH * size.h,
  };
}

// ─── Detection ───────────────────────────────────────────────────────────────────────────────

const fail = (reason: DetectFailure, faces = 0): DetectResult => ({
  landmarks: null,
  confidence: 0,
  faces,
  reason,
});

let defaultLoader: LandmarkerLoader | null = null;

/**
 * Wire the loader once at worker start-up so `detect(bitmap)` matches its one-argument
 * contract. Without it, `detect` reports `unsupported` and the user places the points by hand —
 * which is a working product, just a slower one.
 */
export function setDefaultLandmarkerLoader(loader: LandmarkerLoader | null): void {
  defaultLoader = loader;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("landmarker load timed out")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * Find the eye line and the chin in a photo.
 *
 * Never throws and never rejects. Every failure — no model, blocked assets, an unreadable
 * bitmap, an implausible face — comes back as `landmarks: null` with a `reason`, because the
 * caller's answer to all of them is the same: show the manual positioner.
 */
export async function detect(bitmap: ImageBitmap, opts: DetectOptions = {}): Promise<DetectResult> {
  const load = opts.loadLandmarker ?? defaultLoader;
  if (!load) return fail("unsupported");
  if (!bitmap || !(bitmap.width > 0) || !(bitmap.height > 0)) return fail("unsupported");

  let landmarker: FaceLandmarkerLike;
  try {
    landmarker = await withTimeout(
      Promise.resolve(load()),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  } catch {
    return fail("unsupported");
  }

  let faceLandmarks: readonly (readonly Point[])[];
  try {
    const result = landmarker.detect(bitmap);
    faceLandmarks = result?.faceLandmarks ?? [];
  } catch {
    // A GL context that could not be created, an unsupported bitmap format, a wasm abort.
    return fail("unsupported");
  }

  const size = { w: bitmap.width, h: bitmap.height };
  const scored: FaceScore[] = [];
  for (const face of faceLandmarks) {
    const s = face ? scoreFace(face, size) : null;
    if (s) scored.push(s);
  }

  const facesDetected = faceLandmarks.length;
  if (scored.length === 0) {
    // Something was detected but nothing survived measurement — a chin above the eyebrows, a
    // truncated landmark array. That is a different story from an empty photo, and the UI can
    // say so ("we could not read that face") instead of the wrong one ("we saw nobody").
    return fail(facesDetected === 0 ? "no-face" : "low-confidence", 0);
  }

  // Rank by confidence, then by size: two equally plausible faces are resolved by "the subject
  // of a portrait is the big one".
  scored.sort((a, b) => b.confidence - a.confidence || b.faceHeightPx - a.faceHeightPx);
  const best = scored[0];

  const largest = Math.max(...scored.map((s) => s.faceHeightPx));
  const faces = scored.filter((s) => s.faceHeightPx >= BACKGROUND_FACE_RATIO * largest).length;

  const detail: DetectDetail = {
    facesDetected,
    candidate: best.landmarks,
    pupilY: best.pupilY,
    rollDeg: best.rollDeg,
    factors: best.factors,
  };

  // Order matters. Two people in the photo is a question for the user, not a confidence problem
  // to be scored away, so it is answered before the threshold.
  if (faces > 1) {
    return { landmarks: null, confidence: best.confidence, faces, reason: "multiple-faces", detail };
  }

  const min = opts.minConfidence ?? MIN_CONFIDENCE;
  if (best.confidence < min) {
    return { landmarks: null, confidence: best.confidence, faces, reason: "low-confidence", detail };
  }

  return { landmarks: best.landmarks, confidence: best.confidence, faces, detail };
}

// ─── MediaPipe wiring ────────────────────────────────────────────────────────────────────────

/**
 * The slice of `@mediapipe/tasks-vision` the loader needs. Structural, so the real module
 * namespace satisfies it, and so this file compiles and unit-tests without the 15 MB dependency
 * being installed. The worker passes the real one in:
 *
 *     import * as vision from "@mediapipe/tasks-vision";
 *     setDefaultLandmarkerLoader(createMediaPipeLoader(vision, MEDIAPIPE_SELF_HOSTED));
 */
export interface MediaPipeVisionModule {
  FilesetResolver: { forVisionTasks(basePath?: string, useModule?: boolean): Promise<unknown> };
  FaceLandmarker: {
    createFromOptions(fileset: unknown, options: MediaPipeCreateOptions): Promise<FaceLandmarkerLike>;
  };
}

interface MediaPipeCreateOptions {
  baseOptions: { modelAssetPath: string; delegate: "CPU" | "GPU" };
  runningMode: "IMAGE";
  numFaces: number;
  minFaceDetectionConfidence: number;
  minFacePresenceConfidence: number;
  canvas?: OffscreenCanvas;
}

export interface MediaPipeLoaderOptions {
  /** Same-origin directory holding vision_wasm_internal.{js,wasm} — never a CDN. */
  wasmBase: string;
  /** Same-origin path to face_landmarker.task. */
  modelPath: string;
  /**
   * Must be >1 or a second face is invisible to us: MediaPipe returns at most `numFaces`, so
   * asking for one guarantees the multiple-faces case can never be reported. Four is enough to
   * know "more than one" and bounds the work, since the landmark model runs per face.
   */
  maxFaces?: number;
  /**
   * "CPU" on purpose. This runs once, on a still image, where 40ms versus 120ms is invisible,
   * and the GPU path adds a WebGL context that can fail outright in a worker and can vary by
   * driver. Precision and determinism over speed.
   */
  delegate?: "CPU" | "GPU";
  minFaceDetectionConfidence?: number;
}

/** Where `scripts/` is expected to copy the self-hosted assets. See the report / README. */
export const MEDIAPIPE_SELF_HOSTED: MediaPipeLoaderOptions = {
  wasmBase: "/mediapipe/wasm",
  modelPath: "/mediapipe/face_landmarker.task",
};

export interface DisposableLoader {
  (): Promise<FaceLandmarkerLike>;
  /** Frees the wasm heap (tens of MB). Worth calling when the studio tab goes idle. */
  dispose(): Promise<void>;
}

/**
 * Build a loader over the real MediaPipe module. Memoised: the detector costs ~15 MB of fetch
 * and a wasm instantiation, and a user re-cropping their photo must not pay it twice.
 */
export function createMediaPipeLoader(
  vision: MediaPipeVisionModule,
  opts: MediaPipeLoaderOptions,
): DisposableLoader {
  let pending: Promise<FaceLandmarkerLike> | null = null;

  const loader = (() => {
    if (!pending) {
      pending = (async () => {
        const fileset = await vision.FilesetResolver.forVisionTasks(opts.wasmBase);
        return vision.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: opts.modelPath, delegate: opts.delegate ?? "CPU" },
          runningMode: "IMAGE",
          numFaces: opts.maxFaces ?? 4,
          minFaceDetectionConfidence: opts.minFaceDetectionConfidence ?? 0.5,
          minFacePresenceConfidence: opts.minFaceDetectionConfidence ?? 0.5,
          // MediaPipe binds its GL context here. In a worker there is no <canvas> to fall back
          // on, so one is supplied explicitly; 1x1 because nothing is ever drawn to it.
          ...(typeof OffscreenCanvas === "function" ? { canvas: new OffscreenCanvas(1, 1) } : {}),
        });
      })().catch((e: unknown) => {
        // Do not cache a failure: a blocked asset may simply be a slow first paint, and the
        // next attempt should be allowed to succeed.
        pending = null;
        throw e instanceof Error ? e : new Error(String(e));
      });
    }
    return pending;
  }) as DisposableLoader;

  loader.dispose = async () => {
    const p = pending;
    pending = null;
    if (!p) return;
    try {
      (await p).close?.();
    } catch {
      // Disposal is best-effort; a detector that failed to load has nothing to close.
    }
  };

  return loader;
}
