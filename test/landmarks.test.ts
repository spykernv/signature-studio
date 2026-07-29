import { describe, it, expect } from "vitest";
import {
  detect,
  landmarksFrom,
  scoreFace,
  setDefaultLandmarkerLoader,
  createMediaPipeLoader,
  MIN_CONFIDENCE,
  type FaceLandmarkerLike,
  type Point,
} from "../lib/landmarks";
import { solve, REFERENCE } from "../lib/geometry";

/**
 * The model itself is never run here. It is 15 MB of WASM, it needs a GPU-ish browser, and it
 * is Google's to test. What IS tested is everything between the model and geometry.ts: the
 * index arithmetic, the rejection paths, the thresholds, and the promise that nothing throws.
 *
 * So the fixture is a SYNTHETIC face — landmark arrays built at known pixel positions — which
 * is the only way to assert the conversion exactly rather than approximately.
 */

const OVAL = [
  10, 21, 54, 58, 67, 93, 103, 109, 127, 132, 136, 148, 149, 150, 152, 162, 172, 176, 234, 251,
  284, 288, 297, 323, 332, 338, 356, 361, 365, 377, 378, 379, 389, 397, 400, 454,
];
const BROW_L_LOWER = [46, 53, 52, 65, 55];
const BROW_L_UPPER = [70, 63, 105, 66, 107];
const BROW_R_LOWER = [276, 283, 282, 295, 285];
const BROW_R_UPPER = [300, 293, 334, 296, 336];
const EYE_L = [33, 7, 163, 144, 145, 153, 154, 155, 133, 246, 161, 160, 159, 158, 157, 173];
const EYE_R = [263, 249, 390, 373, 374, 380, 381, 382, 362, 466, 388, 387, 386, 385, 384, 398];
const IRIS_L = [469, 470, 471, 472];
const IRIS_R = [474, 475, 476, 477];

interface FaceSpec {
  w: number;
  h: number;
  /** All in source pixels, like the measurements in build-portrait.sh. */
  faceCx: number;
  browY: number;
  chinY: number;
  eyeGap?: number;
  eyeY?: number;
  browThickness?: number;
  ovalHalfW?: number;
  ovalTop?: number;
  rollDeg?: number;
  /** Iris offset from the eyelid centre — a sideways glance with a motionless head. */
  gazeDx?: number;
  withIris?: boolean;
  /** Swap the two eyebrow rows, to prove the lower one is chosen by measurement. */
  swapBrowRows?: boolean;
  /** An extra oval point dropped below the chin, as a rolled head's jaw corner would be. */
  jawBelowChin?: number;
}

/**
 * Build a 478-point mesh whose measurements are exactly known. Everything is laid out in
 * pixels and normalised at the end, so `rollDeg` is a true rotation rather than one skewed by
 * the aspect ratio — which is the same reason `scoreFace` takes the image size.
 */
function makeFace(spec: FaceSpec): Point[] {
  const {
    w,
    h,
    faceCx,
    browY,
    chinY,
    browThickness = 14,
    rollDeg = 0,
    gazeDx = 0,
    withIris = true,
    swapBrowRows = false,
  } = spec;

  const faceH = chinY - browY;
  // 2.087 is the reference portrait's brow-to-chin over eye separation (240/115), so a face
  // built with the defaults scores 1.0 on `proportion` and the factor under test is isolated.
  const eyeGap = spec.eyeGap ?? faceH / 2.087;
  const eyeY = spec.eyeY ?? browY + 0.155 * faceH;
  const ovalHalfW = spec.ovalHalfW ?? 0.45 * faceH;
  const ovalTop = spec.ovalTop ?? browY - 0.6 * faceH;

  const pts: { x: number; y: number }[] = Array.from({ length: 478 }, () => ({
    x: faceCx,
    y: (browY + chinY) / 2,
  }));

  // Oval: an ellipse from the forehead to the chin, with 152 pinned to the bottom so the
  // lowest point is the chin exactly.
  const cy = (ovalTop + chinY) / 2;
  const ry = (chinY - ovalTop) / 2;
  let slot = 1;
  for (const i of OVAL) {
    const deg = i === 152 ? 90 : 90 + 10 * slot++;
    const rad = (deg * Math.PI) / 180;
    pts[i] = { x: faceCx + ovalHalfW * Math.cos(rad), y: cy + ry * Math.sin(rad) };
  }
  if (spec.jawBelowChin !== undefined) pts[172] = { x: faceCx - ovalHalfW, y: spec.jawBelowChin };

  // Eyebrows: two flat rows per brow, so the mean of a row IS the row's y.
  const rows: Array<[number[], number]> = [
    [swapBrowRows ? BROW_L_UPPER : BROW_L_LOWER, browY],
    [swapBrowRows ? BROW_L_LOWER : BROW_L_UPPER, browY - browThickness],
    [swapBrowRows ? BROW_R_UPPER : BROW_R_LOWER, browY],
    [swapBrowRows ? BROW_R_LOWER : BROW_R_UPPER, browY - browThickness],
  ];
  rows.forEach(([idx, y], n) => {
    const side = n < 2 ? -1 : 1;
    idx.forEach((i, k) => {
      const t = k / (idx.length - 1);
      pts[i] = { x: faceCx + side * ovalHalfW * (0.9 - 0.7 * t), y };
    });
  });

  // Eyelid and iris rings, evenly spaced so each centroid is its centre exactly.
  const ring = (idx: number[], cxp: number, cyp: number, r: number) => {
    idx.forEach((i, k) => {
      const a = (2 * Math.PI * k) / idx.length;
      pts[i] = { x: cxp + r * Math.cos(a), y: cyp + r * Math.sin(a) };
    });
  };
  ring(EYE_L, faceCx - eyeGap / 2, eyeY, eyeGap * 0.22);
  ring(EYE_R, faceCx + eyeGap / 2, eyeY, eyeGap * 0.22);
  if (withIris) {
    ring(IRIS_L, faceCx - eyeGap / 2 + gazeDx, eyeY, eyeGap * 0.08);
    ring(IRIS_R, faceCx + eyeGap / 2 + gazeDx, eyeY, eyeGap * 0.08);
  }

  const out = withIris ? pts : pts.slice(0, 468);

  const rad = (rollDeg * Math.PI) / 180;
  const [cos, sin] = [Math.cos(rad), Math.sin(rad)];
  const px = faceCx;
  const py = (browY + chinY) / 2;
  return out.map((p) => {
    const dx = p.x - px;
    const dy = p.y - py;
    return { x: (px + dx * cos - dy * sin) / w, y: (py + dx * sin + dy * cos) / h };
  });
}

/** The reference photograph's measurements, from build-portrait.sh. */
const REF: FaceSpec = { w: 1080, h: 1620, faceCx: 580, browY: 480, chinY: 720 };

/** The reference face with the whole oval lifted above the eyebrows — a chin that cannot be. */
const chinAboveBrow = (): Point[] =>
  makeFace(REF).map((p, i) => (OVAL.includes(i) ? { x: p.x, y: p.y - 400 / 1620 } : p));

const bitmap = (w: number, h: number) => ({ width: w, height: h }) as unknown as ImageBitmap;
const landmarker = (faces: Point[][]): FaceLandmarkerLike => ({
  detect: () => ({ faceLandmarks: faces }),
});

describe("the conversion, against the reference photograph", () => {
  it("maps synthetic landmarks at the reference positions back to 580/480/720", () => {
    const lm = landmarksFrom(makeFace(REF));
    expect(lm).not.toBeNull();
    expect(lm!.faceCx).toBeCloseTo(580 / 1080, 6);
    expect(lm!.browY).toBeCloseTo(480 / 1620, 6);
    expect(lm!.chinY).toBeCloseTo(720 / 1620, 6);
  });

  it("feeds geometry.solve() something that reproduces the validated crop", () => {
    // The point of the whole module: what comes out of here has to be what the reference was
    // built from. If this drifts, the portrait drifts, whatever else still passes.
    const lm = landmarksFrom(makeFace(REF))!;
    const s = solve(REFERENCE.source, lm);
    expect(s.crop.x).toBeCloseTo(REFERENCE.expectedCrop.x, 0);
    expect(s.crop.y).toBeCloseTo(REFERENCE.expectedCrop.y, 0);
    expect(s.crop.w).toBeCloseTo(REFERENCE.expectedCrop.w, 0);
    expect(s.crop.h).toBeCloseTo(REFERENCE.expectedCrop.h, 0);
    expect(s.geom.rest).toBe(REFERENCE.expectedRest);
    expect(s.ok).toBe(true);
  });

  it("scores a well-framed frontal portrait at full confidence", () => {
    const s = scoreFace(makeFace(REF), { w: 1080, h: 1620 })!;
    expect(s.confidence).toBeCloseTo(1, 3);
    expect(s.rollDeg).toBeCloseTo(0, 6);
  });

  it("reports the pupil line ~37px below browY, as measured on the fixture", () => {
    // The whole reason browY is the eyebrow line and not the pupils — see the module header.
    // If a future change points browY at the irises, this assertion is where it will be caught.
    const s = scoreFace(makeFace({ ...REF, eyeY: 517 }), { w: 1080, h: 1620 })!;
    expect(s.pupilY! * 1620).toBeCloseTo(517, 3);
    expect((s.pupilY! - s.landmarks.browY) * 1620).toBeCloseTo(37, 3);
  });
});

describe("index arithmetic", () => {
  it("takes the LOWER eyebrow row whichever index set it is in", () => {
    const normal = landmarksFrom(makeFace(REF))!;
    const swapped = landmarksFrom(makeFace({ ...REF, swapBrowRows: true }))!;
    expect(swapped.browY).toBeCloseTo(normal.browY, 9);
  });

  it("takes the chin as the lowest oval point, not index 152", () => {
    // A rolled head puts a jaw corner below the chin tip; that corner is what must not be cut.
    const lm = landmarksFrom(makeFace({ ...REF, jawBelowChin: 760 }))!;
    expect(lm.chinY).toBeCloseTo(760 / 1620, 9);
  });

  it("centres on the eyelids, so gaze does not move the frame", () => {
    const straight = landmarksFrom(makeFace(REF))!;
    const glancing = landmarksFrom(makeFace({ ...REF, gazeDx: 20 }))!;
    expect(glancing.faceCx).toBeCloseTo(straight.faceCx, 9);
  });

  it("works on a 468-point mesh, and reports no pupil line", () => {
    const pts = makeFace({ ...REF, withIris: false });
    expect(pts).toHaveLength(468);
    const s = scoreFace(pts, { w: 1080, h: 1620 })!;
    expect(s.landmarks.browY).toBeCloseTo(480 / 1620, 6);
    expect(s.pupilY).toBeNull();
  });

  it("returns null rather than guessing when the mesh is truncated", () => {
    expect(landmarksFrom(makeFace(REF).slice(0, 200))).toBeNull();
    expect(landmarksFrom([])).toBeNull();
  });

  it("returns null on non-finite coordinates", () => {
    const pts = makeFace(REF);
    pts[152] = { x: NaN, y: NaN };
    expect(landmarksFrom(pts)).toBeNull();
  });
});

describe("confidence", () => {
  const size = { w: 1080, h: 1620 };

  it("penalises a small face", () => {
    // 3% of the image height: the model's absolute error is now measured in whole photo pixels.
    const small = scoreFace(makeFace({ ...REF, browY: 700, chinY: 748 }), size)!;
    expect(small.factors.size).toBeLessThan(0.4);
    expect(small.confidence).toBeLessThan(MIN_CONFIDENCE);
  });

  it("forgives a small roll and rejects a large one", () => {
    const slight = scoreFace(makeFace({ ...REF, rollDeg: 5 }), size)!;
    const heavy = scoreFace(makeFace({ ...REF, rollDeg: 28 }), size)!;
    expect(slight.factors.roll).toBe(1);
    expect(Math.abs(slight.rollDeg)).toBeCloseTo(5, 1);
    expect(heavy.factors.roll).toBeLessThan(0.2);
  });

  it("penalises a face turned away", () => {
    // Eyes shifted off the centre of the oval is what a yawed head looks like from the front.
    const turned = scoreFace(makeFace({ ...REF, faceCx: 580, ovalHalfW: 200 }), size)!;
    const yawed = makeFace(REF).map((p, i) =>
      EYE_L.includes(i) || EYE_R.includes(i) ? { x: p.x - 0.05, y: p.y } : p,
    );
    expect(turned.factors.yaw).toBe(1);
    expect(scoreFace(yawed, size)!.factors.yaw).toBeLessThan(1);
  });

  it("penalises implausible proportions", () => {
    const squashed = scoreFace(makeFace({ ...REF, eyeGap: 240 }), size)!;
    expect(squashed.factors.proportion).toBeLessThan(1);
  });

  it("penalises a face falling off the edge of the frame", () => {
    const offEdge = scoreFace(makeFace({ ...REF, chinY: 1700 }), size)!;
    expect(offEdge.factors.inFrame).toBeLessThan(1);
  });

  it("rejects a chin above the eyebrows without throwing", () => {
    expect(scoreFace(chinAboveBrow(), size)).toBeNull();
  });

  it("always lands in 0..1", () => {
    const specs: FaceSpec[] = [
      REF,
      { ...REF, rollDeg: 75 },
      { ...REF, browY: 10, chinY: 1610 },
      { ...REF, eyeGap: 1 },
      { ...REF, faceCx: -200 },
      { ...REF, browY: 700, chinY: 702 },
    ];
    for (const spec of specs) {
      const s = scoreFace(makeFace(spec), size);
      if (s) {
        expect(s.confidence).toBeGreaterThanOrEqual(0);
        expect(s.confidence).toBeLessThanOrEqual(1);
      }
    }
  });

  it("rejects a zero-sized image instead of dividing by it", () => {
    expect(scoreFace(makeFace(REF), { w: 0, h: 0 })).toBeNull();
  });
});

describe("detect", () => {
  it("returns the landmarks for a single good face", async () => {
    const r = await detect(bitmap(1080, 1620), {
      loadLandmarker: async () => landmarker([makeFace(REF)]),
    });
    expect(r.reason).toBeUndefined();
    expect(r.faces).toBe(1);
    expect(r.confidence).toBeCloseTo(1, 3);
    expect(r.landmarks!.browY).toBeCloseTo(480 / 1620, 6);
  });

  it("reports no-face", async () => {
    const r = await detect(bitmap(1080, 1620), { loadLandmarker: async () => landmarker([]) });
    expect(r).toMatchObject({ landmarks: null, confidence: 0, faces: 0, reason: "no-face" });
  });

  it("reports multiple faces and refuses to choose", async () => {
    const other = makeFace({ ...REF, faceCx: 300, browY: 500, chinY: 720 });
    const r = await detect(bitmap(1080, 1620), {
      loadLandmarker: async () => landmarker([makeFace(REF), other]),
    });
    expect(r.reason).toBe("multiple-faces");
    expect(r.landmarks).toBeNull();
    expect(r.faces).toBe(2);
    // Refusing to choose is not refusing to help: the UI still gets a starting position.
    expect(r.detail!.candidate).not.toBeNull();
  });

  it("ignores a face in the background rather than blocking on it", async () => {
    // A passer-by a quarter the size of the subject is not a second subject.
    const passerBy = makeFace({ ...REF, faceCx: 200, browY: 300, chinY: 348 });
    const r = await detect(bitmap(1080, 1620), {
      loadLandmarker: async () => landmarker([makeFace(REF), passerBy]),
    });
    expect(r.faces).toBe(1);
    expect(r.detail!.facesDetected).toBe(2);
    expect(r.landmarks).not.toBeNull();
  });

  it("rejects a low-confidence detection but keeps the candidate for the manual handles", async () => {
    const tiny = makeFace({ ...REF, browY: 700, chinY: 748 });
    const r = await detect(bitmap(1080, 1620), { loadLandmarker: async () => landmarker([tiny]) });
    expect(r.reason).toBe("low-confidence");
    expect(r.landmarks).toBeNull();
    expect(r.detail!.candidate).not.toBeNull();
    expect(r.detail!.factors.size).toBeLessThan(1);
  });

  it("honours a caller's threshold", async () => {
    const tiny = makeFace({ ...REF, browY: 700, chinY: 748 });
    const r = await detect(bitmap(1080, 1620), {
      loadLandmarker: async () => landmarker([tiny]),
      minConfidence: 0,
    });
    expect(r.reason).toBeUndefined();
    expect(r.landmarks).not.toBeNull();
  });

  it("says low-confidence, not no-face, when a detection cannot be measured", async () => {
    const r = await detect(bitmap(1080, 1620), {
      loadLandmarker: async () => landmarker([chinAboveBrow()]),
    });
    expect(r.landmarks).toBeNull();
    expect(r.reason).toBe("low-confidence");
  });
});

describe("detect fails softly, always", () => {
  const good = bitmap(1080, 1620);

  it("no loader wired", async () => {
    setDefaultLandmarkerLoader(null);
    await expect(detect(good)).resolves.toMatchObject({ landmarks: null, reason: "unsupported" });
  });

  it("uses the default loader once wired, then lets it be removed", async () => {
    setDefaultLandmarkerLoader(async () => landmarker([makeFace(REF)]));
    expect((await detect(good)).landmarks).not.toBeNull();
    setDefaultLandmarkerLoader(null);
    expect((await detect(good)).reason).toBe("unsupported");
  });

  it("the loader rejects — a blocked or missing model file", async () => {
    const r = await detect(good, {
      loadLandmarker: async () => {
        throw new Error("failed to fetch /mediapipe/face_landmarker.task");
      },
    });
    expect(r).toMatchObject({ landmarks: null, confidence: 0, faces: 0, reason: "unsupported" });
  });

  it("the loader hangs — the fetch never resolves", async () => {
    const r = await detect(good, {
      loadLandmarker: () => new Promise<FaceLandmarkerLike>(() => {}),
      timeoutMs: 10,
    });
    expect(r.reason).toBe("unsupported");
  });

  it("the model throws mid-inference — no WebGL context, a wasm abort", async () => {
    const r = await detect(good, {
      loadLandmarker: async () => ({
        detect: () => {
          throw new Error("Failed to create WebGL context");
        },
      }),
    });
    expect(r.reason).toBe("unsupported");
  });

  it("the model returns something malformed", async () => {
    const shapes: unknown[] = [
      undefined,
      null,
      {},
      { faceLandmarks: null },
      { faceLandmarks: [[]] },
      { faceLandmarks: [[{ x: NaN, y: NaN }]] },
      { faceLandmarks: [Array.from({ length: 478 }, () => ({ x: 0, y: 0 }))] },
    ];
    for (const shape of shapes) {
      const r = await detect(good, {
        // The point of the test is a model that does not honour its own contract, so the cast
        // is the subject rather than a shortcut.
        loadLandmarker: async () => ({ detect: () => shape }) as unknown as FaceLandmarkerLike,
      });
      expect(r.landmarks).toBeNull();
      expect(r.confidence).toBe(0);
    }
  });

  it("a useless bitmap", async () => {
    const load = async () => landmarker([makeFace(REF)]);
    expect((await detect(bitmap(0, 0), { loadLandmarker: load })).reason).toBe("unsupported");
    expect(
      (await detect(null as unknown as ImageBitmap, { loadLandmarker: load })).reason,
    ).toBe("unsupported");
  });
});

describe("the MediaPipe loader", () => {
  /** A stand-in for the real module namespace — same shape, none of the weight. */
  function fakeVision(onCreate: () => void) {
    return {
      FilesetResolver: { forVisionTasks: async (base?: string) => ({ base }) },
      FaceLandmarker: {
        createFromOptions: async (_f: unknown, o: unknown) => {
          onCreate();
          created.push(o);
          return landmarker([makeFace(REF)]);
        },
      },
    };
  }
  const created: unknown[] = [];

  it("loads once and reuses the detector", async () => {
    let calls = 0;
    const load = createMediaPipeLoader(fakeVision(() => calls++), {
      wasmBase: "/mediapipe/wasm",
      modelPath: "/mediapipe/face_landmarker.task",
    });
    await detect(bitmap(1080, 1620), { loadLandmarker: load });
    await detect(bitmap(1080, 1620), { loadLandmarker: load });
    expect(calls).toBe(1);
  });

  it("asks for more than one face, or the multiple-faces case could never happen", async () => {
    const load = createMediaPipeLoader(fakeVision(() => {}), {
      wasmBase: "/w",
      modelPath: "/m.task",
    });
    await load();
    const opts = created[created.length - 1] as { numFaces: number; baseOptions: unknown };
    expect(opts.numFaces).toBeGreaterThan(1);
    expect(opts.baseOptions).toMatchObject({ modelAssetPath: "/m.task", delegate: "CPU" });
  });

  it("does not cache a failure", async () => {
    let attempts = 0;
    const vision = {
      FilesetResolver: {
        forVisionTasks: async () => {
          attempts++;
          if (attempts === 1) throw new Error("offline");
          return {};
        },
      },
      FaceLandmarker: { createFromOptions: async () => landmarker([makeFace(REF)]) },
    };
    const load = createMediaPipeLoader(vision, { wasmBase: "/w", modelPath: "/m.task" });
    expect((await detect(bitmap(1080, 1620), { loadLandmarker: load })).reason).toBe("unsupported");
    expect((await detect(bitmap(1080, 1620), { loadLandmarker: load })).landmarks).not.toBeNull();
    expect(attempts).toBe(2);
  });

  it("disposes without throwing, loaded or not", async () => {
    const load = createMediaPipeLoader(fakeVision(() => {}), {
      wasmBase: "/w",
      modelPath: "/m.task",
    });
    await expect(load.dispose()).resolves.toBeUndefined();
    await load();
    await expect(load.dispose()).resolves.toBeUndefined();
  });
});
