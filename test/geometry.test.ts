import { describe, it, expect } from "vitest";
import {
  solve,
  REFERENCE,
  PHOTO_H,
  REST_MIN,
  REST_MAX,
  FACE_MARGIN,
  MAX_OVERHANG,
  type Landmarks,
} from "../lib/geometry";

/**
 * The reference case is the contract. jonathan-naal/videos produced one signature that was
 * validated by eye over several rounds; if the solver stops reproducing its crop and its band
 * geometry, the port has drifted, whatever else still passes.
 */
describe("reference reproduction", () => {
  const s = solve(REFERENCE.source, REFERENCE.landmarks);

  it("reproduces crop=756:945:202:102", () => {
    // The reference is stated in integers because ffmpeg's crop filter demands them; the
    // solver keeps floats, so compare to the pixel rather than to the bit.
    expect(s.crop.x).toBeCloseTo(REFERENCE.expectedCrop.x, 0);
    expect(s.crop.y).toBeCloseTo(REFERENCE.expectedCrop.y, 0);
    expect(s.crop.w).toBeCloseTo(REFERENCE.expectedCrop.w, 0);
    expect(s.crop.h).toBeCloseTo(REFERENCE.expectedCrop.h, 0);
  });

  it("reproduces REST=24 and WINDOW_H=212", () => {
    expect(s.geom.rest).toBe(REFERENCE.expectedRest);
    expect(s.geom.windowH).toBe(REFERENCE.expectedWindowH);
  });

  it("puts the windows flush with the photo edges, as the reference does", () => {
    expect(s.geom.highTop).toBe(0);
    expect(s.geom.lowTop + s.geom.windowH).toBe(PHOTO_H);
  });

  it("lands the eye line at 104 and the chin at 170", () => {
    expect(s.placed.brow).toBeCloseTo(104, 0);
    expect(s.placed.chin).toBeCloseTo(170, 0);
  });

  it("lands the hairline just below the low-window edge, as asked", () => {
    // The visible rule Jonathan settled on: hair sits slightly under the second bar's edge.
    expect(s.placed.hairTop).toBeCloseTo(56, 0);
    expect(s.placed.hairTop - s.geom.overlap.top).toBeCloseTo(FACE_MARGIN, 0);
  });

  it("raises no warnings on a well-framed photo", () => {
    expect(s.warnings).toEqual([]);
  });
});

/**
 * The property that actually matters, asserted over adversarial inputs rather than one photo:
 * no band edge may cross the face. Everything else is aesthetics.
 */
describe("the face is never cut", () => {
  const cases: Array<{ name: string; src: { w: number; h: number }; lm: Landmarks }> = [
    { name: "reference", src: { w: 1080, h: 1620 }, lm: REFERENCE.landmarks },
    { name: "tiny distant face", src: { w: 4000, h: 3000 }, lm: { faceCx: 0.5, browY: 0.30, chinY: 0.34 } },
    { name: "face fills the frame", src: { w: 900, h: 1200 }, lm: { faceCx: 0.5, browY: 0.22, chinY: 0.72 } },
    { name: "landscape source", src: { w: 4000, h: 3000 }, lm: { faceCx: 0.62, browY: 0.28, chinY: 0.55 } },
    { name: "head near the top edge", src: { w: 1080, h: 1620 }, lm: { faceCx: 0.5, browY: 0.06, chinY: 0.20 } },
    { name: "head near the bottom edge", src: { w: 1080, h: 1620 }, lm: { faceCx: 0.5, browY: 0.78, chinY: 0.94 } },
    { name: "face hard against the left", src: { w: 1600, h: 1200 }, lm: { faceCx: 0.08, browY: 0.30, chinY: 0.55 } },
    { name: "face hard against the right", src: { w: 1600, h: 1200 }, lm: { faceCx: 0.94, browY: 0.30, chinY: 0.55 } },
    { name: "square source", src: { w: 1200, h: 1200 }, lm: { faceCx: 0.5, browY: 0.28, chinY: 0.50 } },
    { name: "very tall source", src: { w: 900, h: 2400 }, lm: { faceCx: 0.5, browY: 0.18, chinY: 0.30 } },
  ];

  for (const c of cases) {
    it(`${c.name}: either the face is clear of every band edge, or we refuse`, () => {
      const s = solve(c.src, c.lm);
      const { top, bottom } = s.geom.overlap;

      // The binding property, and the whole reason this module exists: a band edge inside
      // [hairTop, chin] is a visible slice through the user's face — the exact defect that
      // took four manual rounds to remove by hand on a single photo.
      //
      // Refusing is a legitimate outcome. Some photographs simply do not contain the headroom
      // the framing needs, and no arithmetic invents it. What is NOT acceptable is rendering a
      // sliced face while reporting success.
      if (s.ok) {
        expect(s.placed.chin).toBeLessThanOrEqual(bottom);
        expect(s.placed.hairTop).toBeGreaterThanOrEqual(top);
      } else {
        expect(s.warnings).toContain("cannot-frame");
      }
    });

    it(`${c.name}: overhang past the source stays within the white-fill allowance`, () => {
      const s = solve(c.src, c.lm);
      // The crop is allowed to leave the image — the grader fills that with white — but only
      // up to MAX_OVERHANG, past which the composition stops reading as deliberate.
      const slackX = MAX_OVERHANG * s.crop.w + 1;
      const slackY = MAX_OVERHANG * s.crop.h + 1;
      expect(s.crop.x).toBeGreaterThanOrEqual(-slackX);
      expect(s.crop.y).toBeGreaterThanOrEqual(-slackY);
      expect(s.crop.x + s.crop.w).toBeLessThanOrEqual(c.src.w + slackX);
      expect(s.crop.y + s.crop.h).toBeLessThanOrEqual(c.src.h + slackY);
    });

    it(`${c.name}: REST stays in range and WINDOW_H stays derived`, () => {
      const s = solve(c.src, c.lm);
      expect(s.geom.rest).toBeGreaterThanOrEqual(REST_MIN);
      expect(s.geom.rest).toBeLessThanOrEqual(REST_MAX);
      expect(s.geom.windowH).toBe(PHOTO_H - 2 * s.geom.rest);
    });
  }
});

describe("degenerate input", () => {
  it("does not throw when chin is above the eye line", () => {
    const s = solve({ w: 1080, h: 1620 }, { faceCx: 0.5, browY: 0.6, chinY: 0.2 });
    expect(s.crop.w).toBeGreaterThan(0);
    expect(s.geom.windowH).toBeGreaterThan(0);
  });

  it("does not throw when the two landmarks coincide", () => {
    const s = solve({ w: 1080, h: 1620 }, { faceCx: 0.5, browY: 0.4, chinY: 0.4 });
    expect(s.crop.w).toBeGreaterThan(0);
  });
});
