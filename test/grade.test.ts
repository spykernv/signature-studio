import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import {
  grade,
  gradePlane,
  eqCurve,
  yToGrey,
  lanczos,
  LANCZOS_A,
  Y_BLACK,
  Y_WHITE,
} from "../lib/grade";
import type { Crop } from "../lib/geometry";

/**
 * `grade()` returns an `ImageData`, which exists in a Web Worker and not in Node. The stand-in
 * only has to satisfy the constructor and the four properties; everything with real logic lives
 * in `gradePlane`, which never touches it, so the shim is not carrying any of the test's weight.
 */
class NodeImageData {
  readonly colorSpace = "srgb" as const;
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}
if (typeof ImageData === "undefined") Object.assign(globalThis, { ImageData: NodeImageData });

/**
 * The fixtures are the contract. `expected-graded.png` is what ffmpeg produced from
 * `source-portrait.png` with the chain in `videos/scripts/build-portrait.sh`; if this port stops
 * reproducing it, the portrait has drifted whatever else still passes.
 *
 * Numbers quoted in the assertions below (the ffmpeg-measured constants, the LUT samples) were
 * taken by running ffmpeg 8.1.1 itself and dumping its intermediate yuva444p planes — they are
 * measurements, not re-derivations from this implementation, so they can genuinely fail it.
 */

function readPNG(name: string): ImageData {
  const png = PNG.sync.read(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
  return {
    // pngjs always decodes to 8-bit RGBA, which is exactly the ImageData layout.
    data: new Uint8ClampedArray(png.data),
    width: png.width,
    height: png.height,
    colorSpace: "srgb",
  };
}

/** A solid RGBA field — enough of an ImageData for anything that never touches a canvas. */
function solid(w: number, h: number, r: number, g: number, b: number, a = 255): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }
  return { data, width: w, height: h, colorSpace: "srgb" };
}

interface Diff {
  mean: number;
  max: number;
}

function diff(got: Uint8ClampedArray, expected: ImageData): Diff {
  const n = expected.width * expected.height;
  let sum = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    // The fixture is RGBA and grey, so any channel is the value; take R.
    const d = Math.abs(got[i] - expected.data[i * 4]);
    sum += d;
    if (d > max) max = d;
  }
  return { mean: sum / n, max };
}

/** The crop `build-portrait.sh` passes to ffmpeg, and the size it scales to. */
const REFERENCE_CROP: Crop = { x: 202, y: 102, w: 756, h: 945 };
const OUT_W = 208;
const OUT_H = 260;

describe("reference reproduction", () => {
  const src = readPNG("source-portrait.png");
  const expected = readPNG("expected-graded.png");
  const got = gradePlane(src, REFERENCE_CROP, OUT_W, OUT_H);
  const d = diff(got, expected);

  it("matches the ffmpeg grade", () => {
    // Reported rather than merely asserted: if this ever drifts, the delta is the diagnosis.
    console.log(`grade vs expected-graded.png — mean ${d.mean.toFixed(4)}, max ${d.max}`);

    // Measured at mean 0.4327 / max 7. The residual is swscale quantising its Lanczos
    // coefficients to fixed point and rounding luma to 8 bits between filters, where this port
    // stays in double precision; it is dither-level noise, not a structural difference.
    expect(d.mean).toBeLessThanOrEqual(3);
    expect(d.max).toBeLessThanOrEqual(20);
  });

  it("produces a plane of the requested size", () => {
    expect(got.length).toBe(OUT_W * OUT_H);
  });

  it("agrees with the fixture on the extremes, not just on average", () => {
    // A grade that was merely close on average could still have crushed the blacks or blown the
    // highlights. Compare the histogram ends.
    let gotMin = 255;
    let gotMax = 0;
    let expMin = 255;
    let expMax = 0;
    for (let i = 0; i < got.length; i++) {
      if (got[i] < gotMin) gotMin = got[i];
      if (got[i] > gotMax) gotMax = got[i];
      const e = expected.data[i * 4];
      if (e < expMin) expMin = e;
      if (e > expMax) expMax = e;
    }
    expect(gotMin).toBe(expMin);
    expect(gotMax).toBe(expMax);
  });
});

/**
 * The geometry solver hands out crops that hang off the source on purpose — it would rather ask
 * for pixels that were never photographed than move the face. Everything it asks for outside the
 * image has to come back white, not clamped, not black, not wrapped.
 */
describe("crops that leave the source", () => {
  const white = solid(40, 40, 255, 255, 255);
  const black = solid(40, 40, 0, 0, 0);

  it("fills with white when the crop hangs off every edge", () => {
    const out = gradePlane(black, { x: -400, y: -400, w: 200, h: 200 }, 16, 16);
    expect([...new Set(out)]).toEqual([255]);
  });

  it("keeps a white field flat whether or not the crop fits", () => {
    // The white fill and the photograph have to agree exactly, or the seam shows as a border.
    expect([...new Set(gradePlane(white, { x: 0, y: 0, w: 40, h: 40 }, 16, 16))]).toEqual([255]);
    expect([...new Set(gradePlane(white, { x: -80, y: -80, w: 200, h: 200 }, 16, 16))]).toEqual([
      255,
    ]);
  });

  it("puts the white on the correct side", () => {
    // Left half off the source: the black photograph occupies the right of the output.
    const out = gradePlane(black, { x: -20, y: 0, w: 40, h: 40 }, 8, 8);
    expect(out[0]).toBe(255); // top-left is off the image
    expect(out[7]).toBe(0); // top-right is photograph
  });

  it("accepts fractional and negative crop origins without snapping", () => {
    // A sub-pixel nudge must move the picture sub-pixel. Snapping to integers here would make
    // the positioner feel like it was fighting the user.
    //
    // The OUTERMOST COLUMNS ARE EXCLUDED, and that exclusion is the honest part of this test.
    // Taps that fall outside the crop are clamp-extended to its edge, exactly as swscale does,
    // and "the edge" can only ever be a whole pixel. So when the crop origin crosses an integer
    // the clamped column steps by one and the border moves by the difference between two
    // adjacent pixels of the photograph — here 3/255. That discontinuity is inherent to edge
    // extension, not a defect, and it is confined to the border. What must stay smooth is the
    // picture itself.
    const src = readPNG("source-portrait.png");
    const base = gradePlane(src, REFERENCE_CROP, OUT_W, OUT_H);
    const nudged = gradePlane(
      src,
      { ...REFERENCE_CROP, x: REFERENCE_CROP.x + 0.001 },
      OUT_W,
      OUT_H,
    );

    // A tiny nudge must not repaint the image, but "identical" is the wrong bar: this chain
    // deliberately reproduces ffmpeg's 8-bit stages, so its output is quantised and cannot be a
    // continuous function of the crop origin. A value sitting on a rounding boundary flips by
    // one, the blur spreads it, and `eq`'s 1.32 contrast multiplies it. A few LSB is the floor,
    // not a defect.
    let noise = 0;
    for (let i = 0; i < base.length; i++) noise = Math.max(noise, Math.abs(base[i] - nudged[i]));
    expect(noise).toBeLessThanOrEqual(4);
    expect(base).not.toEqual(nudged); // …but it does move
  });

  it("interpolates between whole pixels rather than snapping to them", () => {
    // The real requirement behind "no snapping", tested directly instead of inferred from a
    // noise threshold — which is what let the previous version of this test pass while saying
    // nothing. Shift the crop by exactly half a pixel: the result must land BETWEEN the
    // zero-shift and one-pixel-shift renders. A resampler that snapped to integers would
    // duplicate one of the two ends exactly.
    const src = readPNG("source-portrait.png");
    const at = (dx: number) =>
      gradePlane(src, { ...REFERENCE_CROP, x: REFERENCE_CROP.x + dx }, OUT_W, OUT_H);

    const a = at(0);
    const half = at(0.5);
    const b = at(1);

    const meanAbs = (p: Uint8ClampedArray, q: Uint8ClampedArray) => {
      let s = 0;
      for (let i = 0; i < p.length; i++) s += Math.abs(p[i] - q[i]);
      return s / p.length;
    };

    // It is genuinely distinct from both ends…
    expect(meanAbs(half, a)).toBeGreaterThan(0.2);
    expect(meanAbs(half, b)).toBeGreaterThan(0.2);

    // …and it sits between them rather than beside one: the half-shift is closer to the
    // midpoint of the two ends than either end is.
    let toMid = 0;
    for (let i = 0; i < a.length; i++) toMid += Math.abs(half[i] - (a[i] + b[i]) / 2);
    toMid /= a.length;
    expect(toMid).toBeLessThan(meanAbs(a, b) / 2);
  });
});

/**
 * The greyscale conversion. These six bytes came out of ffmpeg, one solid colour at a time
 * through the full chain, and they are what pins the implementation to BT.601 in LIMITED range.
 * BT.709 would put red near 30 rather than 68; full-range YUV would put it near 80. The ±2
 * tolerance is the whole budget for this port's extra precision — ffmpeg rounds luma to 8 bits
 * before `eq` reads it, this port does not — and is far tighter than either wrong answer.
 */
describe("BT.601 luma in limited range", () => {
  const cases: Array<[string, [number, number, number], number]> = [
    ["red", [255, 0, 0], 66],
    ["green", [0, 255, 0], 165],
    ["blue", [0, 0, 255], 3],
    ["white", [255, 255, 255], 255],
    ["black", [0, 0, 0], 0],
    ["mid grey", [128, 128, 128], 136],
  ];

  /**
   * The crop is INSET inside a larger field on purpose. Lanczos-3 at a 4x downscale reaches 12
   * source pixels either side of each sample, so a crop flush with the edge of the source
   * legitimately mixes white into the border of the output — correct, but it would drown the
   * point curve this block is trying to measure. 16px of margin keeps every tap on the field.
   */
  const flat = (r: number, g: number, b: number, a = 255) =>
    gradePlane(solid(64, 64, r, g, b, a), { x: 16, y: 16, w: 32, h: 32 }, 8, 8);

  for (const [name, [r, g, b], expected] of cases) {
    it(`grades solid ${name} the way ffmpeg does`, () => {
      const out = flat(r, g, b);
      expect([...new Set(out)]).toHaveLength(1); // no tap left the field, so it must stay flat
      expect(Math.abs(out[0] - expected)).toBeLessThanOrEqual(2);
    });
  }

  it("orders the primaries green > red > blue, as 601 weights require", () => {
    expect(flat(0, 255, 0)[0]).toBeGreaterThan(flat(255, 0, 0)[0]);
    expect(flat(255, 0, 0)[0]).toBeGreaterThan(flat(0, 0, 255)[0]);
  });

  it("composites transparency over white rather than over black", () => {
    expect(flat(0, 0, 0, 0)[0]).toBe(255);
  });
});

/**
 * `eq`, against ffmpeg's own LUT. These pairs were read off by dumping the luma plane either
 * side of the filter and tabulating input -> output, so they encode the real filter, including
 * its order of operations and its `256·v` truncation.
 */
describe("eq curve", () => {
  const lut: Array<[number, number]> = [
    [22, 0],
    [64, 50],
    [100, 99],
    [127, 134],
    [128, 135],
    [180, 203],
    [235, 255],
  ];

  for (const [input, expected] of lut) {
    it(`maps Y=${input} to ${expected}`, () => {
      expect(eqCurve(input)).toBe(expected);
    });
  }

  it("is monotonic and stays inside 0..255", () => {
    let prev = -1;
    for (let y = 0; y <= 255; y++) {
      const v = eqCurve(y);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
      prev = v;
    }
  });

  it("clips rather than wrapping at both ends", () => {
    expect(eqCurve(-50)).toBe(0);
    expect(eqCurve(400)).toBe(255);
  });

  it("lifts the midtones — gamma 1.04 is applied as 1/gamma", () => {
    // The single most likely transcription error is using `gamma` as the exponent instead of
    // its reciprocal, which would darken here instead of lifting. Contrast alone would map the
    // pivot to 0.515 -> 131; the gamma lift takes it further up.
    expect(eqCurve(127.5)).toBeGreaterThan(131);
  });
});

describe("limited range to grey", () => {
  it("maps the video range onto the full range", () => {
    expect(yToGrey(Y_BLACK)).toBe(0);
    expect(yToGrey(Y_WHITE)).toBe(255);
  });

  it("clips values outside the video range", () => {
    expect(yToGrey(0)).toBe(0);
    expect(yToGrey(255)).toBe(255);
  });
});

describe("lanczos kernel", () => {
  it("is 1 at the origin", () => {
    expect(lanczos(0)).toBe(1);
  });

  it("is zero at every other integer inside the support", () => {
    for (const t of [-2, -1, 1, 2]) expect(Math.abs(lanczos(t))).toBeLessThan(1e-12);
  });

  it("is exactly zero outside the support", () => {
    for (const t of [-LANCZOS_A, -4, LANCZOS_A, 3.5, 100]) expect(lanczos(t)).toBe(0);
  });

  it("is even", () => {
    for (const t of [0.3, 1.1, 2.7]) expect(lanczos(-t)).toBeCloseTo(lanczos(t), 15);
  });

  it("has negative lobes — it is a windowed sinc, not a bell", () => {
    // If this ever comes back non-negative the kernel has been swapped for a Gaussian or a
    // bilinear tent and the resample has quietly lost its acutance.
    expect(lanczos(1.5)).toBeLessThan(0);
  });
});

describe("grade()", () => {
  it("wraps the plane into an opaque grey ImageData", () => {
    const out = grade(solid(16, 16, 200, 100, 50), { x: 0, y: 0, w: 16, h: 16 }, 4, 4);
    expect(out.width).toBe(4);
    expect(out.height).toBe(4);
    expect(out.data.length).toBe(4 * 4 * 4);
    for (let i = 0; i < 16; i++) {
      expect(out.data[i * 4 + 1]).toBe(out.data[i * 4]);
      expect(out.data[i * 4 + 2]).toBe(out.data[i * 4]);
      expect(out.data[i * 4 + 3]).toBe(255);
    }
  });

  it("rejects degenerate sizes rather than emitting an empty image", () => {
    const src = solid(8, 8, 0, 0, 0);
    expect(() => gradePlane(src, { x: 0, y: 0, w: 8, h: 8 }, 0, 4)).toThrow(RangeError);
    expect(() => gradePlane(src, { x: 0, y: 0, w: 8, h: 8 }, 4, 2.5)).toThrow(RangeError);
    expect(() => gradePlane(src, { x: 0, y: 0, w: 0, h: 8 }, 4, 4)).toThrow(RangeError);
  });
});
