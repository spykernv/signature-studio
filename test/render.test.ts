import { describe, it, expect } from "vitest";
import {
  drawShutterFrame,
  drawNameFrame,
  bandWindow,
  bandPolygon,
  nameLayout,
  nameFitsGrid,
  visibleCount,
  caretVisible,
  noise,
  LOOP,
  FPS,
  SETTLED,
  SCATTER_START,
  STEP,
  NAME_W,
  NAME_H,
  MAX_NAME_CHARS,
  BG,
  type Point,
  type NameLayout,
} from "../lib/render";
import {
  solve,
  REFERENCE,
  PHOTO_W,
  PHOTO_H,
  PAD,
  CANVAS_W,
  CANVAS_H,
  BANDS,
  SLOPE,
  SPAN,
  GAP,
  type BandGeometry,
} from "../lib/geometry";

/** The validated geometry, plus the two extremes the solver can produce. Every property below
 * is asserted over all three: a rule that only holds for Jonathan's face is not a rule. */
const REF_GEOM = solve(REFERENCE.source, REFERENCE.landmarks).geom;
const geomAt = (rest: number): BandGeometry => ({
  rest,
  windowH: PHOTO_H - 2 * rest,
  lowTop: 2 * rest,
  highTop: 0,
  overlap: { top: 2 * rest, bottom: PHOTO_H - 2 * rest },
});
const GEOMS: BandGeometry[] = [REF_GEOM, geomAt(14), geomAt(30)];

const FRAMES = Array.from({ length: LOOP }, (_, f) => f);
const KS = Array.from({ length: BANDS }, (_, k) => k);

const restTop = (k: number, geom: BandGeometry) => (k % 2 === 0 ? geom.lowTop : geom.highTop);

/* ------------------------------------------------------------------------------------- */
/* The loop                                                                                */
/* ------------------------------------------------------------------------------------- */

describe("the loop returns to rest", () => {
  it("keeps the contract constants the GIF timing depends on", () => {
    expect(FPS).toBe(25); // 4cs per frame, exactly
    expect(LOOP).toBe(110);
    expect(SETTLED).toBe(54);
  });

  it("makes frame 0 the resting state — Outlook shows only that frame", () => {
    for (const geom of GEOMS) {
      for (const k of KS) {
        expect(bandWindow(k, 0, geom).top).toBe(restTop(k, geom));
      }
    }
  });

  it("ends the loop exactly where it started, so the seam is invisible", () => {
    for (const geom of GEOMS) {
      for (const k of KS) {
        expect(bandWindow(k, LOOP - 1, geom)).toEqual(bandWindow(k, 0, geom));
      }
    }
  });

  it("holds every band at rest before the scatter and after the last arrival", () => {
    for (const geom of GEOMS) {
      for (const k of KS) {
        for (let f = 0; f < SCATTER_START; f += 1) {
          expect(bandWindow(k, f, geom).top).toBe(restTop(k, geom));
        }
        for (let f = SETTLED; f < LOOP; f += 1) {
          expect(bandWindow(k, f, geom).top).toBe(restTop(k, geom));
        }
      }
    }
  });

  it("moves at all in between — otherwise the assertions above are vacuous", () => {
    const moved = FRAMES.filter((f) =>
      KS.some((k) => bandWindow(k, f, REF_GEOM).top !== restTop(k, REF_GEOM)),
    );
    expect(moved.length).toBeGreaterThan(20);
  });
});

describe("the window is always a real number in a sane place", () => {
  it("never produces NaN", () => {
    for (const geom of GEOMS) {
      for (const k of KS) {
        for (const f of FRAMES) {
          const w = bandWindow(k, f, geom);
          expect(Number.isFinite(w.top)).toBe(true);
          expect(Number.isFinite(w.bottom)).toBe(true);
        }
      }
    }
  });

  it("keeps bottom = top + windowH at every frame", () => {
    for (const geom of GEOMS) {
      for (const k of KS) {
        for (const f of FRAMES) {
          const w = bandWindow(k, f, geom);
          expect(w.bottom - w.top).toBeCloseTo(geom.windowH, 10);
        }
      }
    }
  });

  it("never overshoots past the parking spot nor drifts off the wrong side of rest", () => {
    // scattered − arrived must stay in [0, 1]. Below 0 a low band would rise ABOVE its resting
    // height (leaving on the side it does not return from, which reads as a glitch); above 1 it
    // would travel further off-screen than it needs to and waste frames being invisible.
    for (const geom of GEOMS) {
      for (const k of KS) {
        const rest = restTop(k, geom);
        const parked = k % 2 === 0 ? PHOTO_H + 4 : -geom.windowH - 4;
        for (const f of FRAMES) {
          const d = (bandWindow(k, f, geom).top - rest) / (parked - rest);
          expect(d).toBeGreaterThanOrEqual(0);
          expect(d).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

/* ------------------------------------------------------------------------------------- */
/* The polygon                                                                             */
/* ------------------------------------------------------------------------------------- */

const dx = (a: Point, b: Point) => b[0] - a[0];
const dy = (a: Point, b: Point) => b[1] - a[1];

describe("the clip polygon", () => {
  it("is a parallelogram: opposite sides are the same vector", () => {
    for (const k of KS) {
      for (const [top, bottom] of [
        [0, 212],
        [-37, 175],
        [264, 476],
      ]) {
        const p = bandPolygon(k, top, bottom);
        expect(p).toHaveLength(4);
        // top edge === bottom edge (reversed), left edge === right edge
        expect(dx(p[0], p[1])).toBeCloseTo(dx(p[3], p[2]), 10);
        expect(dy(p[0], p[1])).toBeCloseTo(dy(p[3], p[2]), 10);
        expect(dx(p[0], p[3])).toBeCloseTo(dx(p[1], p[2]), 10);
        expect(dy(p[0], p[3])).toBeCloseTo(dy(p[1], p[2]), 10);
      }
    }
  });

  it("leans by SLOPE, and leans because the corners are evaluated at their own y", () => {
    for (const k of KS) {
      const p = bandPolygon(k, 10, 222);
      // A leading edge that moves −SLOPE·Δy horizontally per Δy vertically. This is the lean
      // the DOM version got without any transform, and the reason the photo underneath is
      // never disturbed.
      expect(dx(p[0], p[3]) / dy(p[0], p[3])).toBeCloseTo(-SLOPE, 12);
      expect(dx(p[1], p[2]) / dy(p[1], p[2])).toBeCloseTo(-SLOPE, 12);
    }
  });

  it("is SPAN − GAP wide at every height — the slashes come from here, not from the motion", () => {
    for (const k of KS) {
      for (const [top, bottom] of [
        [0, 212],
        [-300, -88],
        [500, 712],
      ]) {
        const p = bandPolygon(k, top, bottom);
        expect(dx(p[0], p[1])).toBeCloseTo(SPAN - GAP, 10);
        expect(dx(p[3], p[2])).toBeCloseTo(SPAN - GAP, 10);
      }
    }
  });

  it("leaves exactly GAP between adjacent slots regardless of displacement", () => {
    // Measured horizontally at a shared y — the one thing displacement could plausibly break,
    // since the two neighbours are at different heights for most of the loop. It cannot: the
    // slide is parallel to the cut. A degenerate one-pixel window is used purely to read the
    // two edge x's at an arbitrary y.
    const edgesAt = (k: number, y: number) => {
      const p = bandPolygon(k, y, y + 1);
      return { left: p[0][0], right: p[1][0] };
    };
    for (const geom of GEOMS) {
      for (const f of FRAMES) {
        for (let k = 0; k < BANDS - 1; k += 1) {
          for (const y of [
            bandWindow(k, f, geom).top,
            bandWindow(k + 1, f, geom).top,
            PHOTO_H / 2,
          ]) {
            expect(edgesAt(k + 1, y).left - edgesAt(k, y).right).toBeCloseTo(GAP, 10);
          }
        }
      }
    }
  });

  it("covers the photo corners: the union of the slots overhangs both sides", () => {
    // The strips start outside the photo, so a corner is never left uncovered by the very
    // first or very last slot at any height the windows reach.
    const first = bandPolygon(0, 0, PHOTO_H);
    const last = bandPolygon(BANDS - 1, 0, PHOTO_H);
    expect(Math.min(first[0][0], first[3][0])).toBeLessThan(0);
    expect(Math.max(last[1][0], last[2][0])).toBeGreaterThan(PHOTO_W);
  });
});

/* ------------------------------------------------------------------------------------- */
/* Against the reference render                                                            */
/* ------------------------------------------------------------------------------------- */

/**
 * The numbers below were read out of test/fixtures/frames/*.png — the PNG sequence Remotion
 * produced for the signature that was signed off — with a throwaway decoder: the first and
 * last non-white row of a column is where that band's window edge actually landed, and the
 * white run along a row is a slash. They are the only evidence that this port is the same
 * animation and not merely a self-consistent one, so they are asserted here rather than left
 * in a scratch file. Canvas rows; photo space is PAD lower.
 */
describe("matches the frames Remotion actually rendered", () => {
  const photoY = (canvasRow: number) => canvasRow - PAD;
  const photoX = (canvasCol: number) => canvasCol - PAD;

  it("puts band 2's top edge on the fixture row (column x=98, ease-in cubic)", () => {
    // First non-white row = floor(top): the row the edge crosses is antialiased, not white.
    expect(Math.floor(bandWindow(2, 20, REF_GEOM).top)).toBe(photoY(147));
    expect(Math.floor(bandWindow(2, 36, REF_GEOM).top)).toBe(photoY(83));
    expect(Math.floor(bandWindow(2, 44, REF_GEOM).top)).toBe(photoY(56));
  });

  it("puts band 3's bottom edge on the fixture row (column x=158, ease-out cubic)", () => {
    // Last non-white row = ceil(bottom) − 1, which is also right when the edge is an integer.
    expect(Math.ceil(bandWindow(3, 20, REF_GEOM).bottom) - 1).toBe(photoY(167));
    expect(Math.ceil(bandWindow(3, 36, REF_GEOM).bottom) - 1).toBe(photoY(104));
    expect(Math.ceil(bandWindow(3, 44, REF_GEOM).bottom) - 1).toBe(photoY(213));
    expect(Math.ceil(bandWindow(3, 0, REF_GEOM).bottom) - 1).toBe(photoY(219));
  });

  it("puts the slashes where frame-000 has them", () => {
    // Row y=138 of frame-000.png is white over x ∈ [57,59), [120,121), [182,184) — three
    // slashes, unequal in width because a 2.5px gap falls differently on the pixel grid at
    // each x. A band's own displacement never enters into it.
    const edgesAt = (k: number, y: number) => {
      const p = bandPolygon(k, y, y + 1);
      return { left: p[0][0], right: p[1][0] };
    };
    const y = photoY(138);
    for (const [k, from, to] of [
      [1, 57, 59],
      [2, 120, 121],
      [3, 182, 184],
    ]) {
      // A pixel is fully white only if it lies entirely inside the slash.
      expect(Math.ceil(edgesAt(k, y).right)).toBe(photoX(from));
      expect(Math.floor(edgesAt(k + 1, y).left)).toBe(photoX(to));
    }
  });

  it("is settled by 54, as the byte-identical fixtures 000/058/070/090/109 show", () => {
    for (const f of [58, 70, 90, 109]) {
      expect(f).toBeGreaterThanOrEqual(SETTLED);
      for (const k of KS) expect(bandWindow(k, f, REF_GEOM)).toEqual(bandWindow(k, 0, REF_GEOM));
    }
    // …and the fixtures that are NOT identical to frame 0 are the ones still in motion.
    for (const f of [20, 36, 44]) {
      expect(f).toBeLessThan(SETTLED);
      expect(KS.some((k) => bandWindow(k, f, REF_GEOM).top !== restTop(k, REF_GEOM))).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------------------------- */
/* The draw — the overlay invariant                                                        */
/* ------------------------------------------------------------------------------------- */

type Op =
  | { op: "fillRect"; args: number[] }
  | { op: "fillText"; char: string; x: number; y: number }
  | { op: "save" }
  | { op: "restore" }
  | { op: "translate"; x: number; y: number }
  | { op: "clip"; path: Point[] }
  | { op: "drawImage"; src: unknown; args: number[] };

/**
 * A recording stand-in for a 2D context. Node has no canvas, and the invariant that matters
 * — the photograph is drawn at the same place for every band, the polygon alone moves — is a
 * statement about the CALLS, not about pixels. Anything the renderer might reach for that is
 * not implemented here (rotate, scale, setTransform, putImageData…) throws, which is exactly
 * the failure we want: those are the ways the overlay could degenerate into a collage.
 */
function recorder() {
  const ops: Op[] = [];
  let path: Point[] = [];
  const ctx = {
    fillStyle: "",
    font: "",
    textAlign: "start" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low" as ImageSmoothingQuality,
    save: () => void ops.push({ op: "save" }),
    restore: () => void ops.push({ op: "restore" }),
    translate: (x: number, y: number) => void ops.push({ op: "translate", x, y }),
    beginPath: () => {
      path = [];
    },
    moveTo: (x: number, y: number) => void path.push([x, y]),
    lineTo: (x: number, y: number) => void path.push([x, y]),
    closePath: () => {},
    clip: () => void ops.push({ op: "clip", path: [...path] }),
    fillRect: (...args: number[]) => void ops.push({ op: "fillRect", args }),
    fillText: (char: string, x: number, y: number) => void ops.push({ op: "fillText", char, x, y }),
    drawImage: (src: unknown, ...args: number[]) => void ops.push({ op: "drawImage", src, args }),
    measureText: () => ({ fontBoundingBoxAscent: 28, fontBoundingBoxDescent: 8 }),
  };
  // The stub implements the subset the renderer uses; the cast is the price of testing a
  // canvas function without a canvas, and is narrower than typing the parameter loosely.
  return { ops, ctx: ctx as unknown as OffscreenCanvasRenderingContext2D };
}

const PHOTO = { __brand: "photo" } as unknown as CanvasImageSource;

describe("drawShutterFrame draws an overlay, never a collage", () => {
  it("draws the photograph at the same place for every band, at every frame", () => {
    for (const f of [0, 12, 20, 27, 36, 44, 54, 109]) {
      const { ops, ctx } = recorder();
      drawShutterFrame(ctx, PHOTO, f, REF_GEOM);

      const draws = ops.filter((o) => o.op === "drawImage");
      expect(draws).toHaveLength(BANDS);
      for (const d of draws) {
        expect(d.src).toBe(PHOTO);
        // Photo space origin, natural size. If a frame's displacement ever leaks in here the
        // face gets sliced into offset fragments and the GIF balloons — see lib/render.ts.
        expect(d.args).toEqual([0, 0, PHOTO_W, PHOTO_H]);
      }
    }
  });

  it("moves the polygon instead — the clip paths differ frame to frame", () => {
    const clipsAt = (f: number) => {
      const { ops, ctx } = recorder();
      drawShutterFrame(ctx, PHOTO, f, REF_GEOM);
      return ops.filter((o) => o.op === "clip").map((o) => o.path);
    };
    expect(clipsAt(0)).not.toEqual(clipsAt(27));
    expect(clipsAt(0)).toEqual(clipsAt(109));
  });

  it("clips each band to exactly bandPolygon(k, …)", () => {
    const f = 27;
    const { ops, ctx } = recorder();
    drawShutterFrame(ctx, PHOTO, f, REF_GEOM);
    const clips = ops.filter((o) => o.op === "clip");
    expect(clips).toHaveLength(BANDS);
    for (const k of KS) {
      const { top, bottom } = bandWindow(k, f, REF_GEOM);
      expect(clips[k].path).toEqual(bandPolygon(k, top, bottom));
    }
  });

  it("applies the PAD offset once, as a translate, and nothing else", () => {
    const { ops, ctx } = recorder();
    drawShutterFrame(ctx, PHOTO, 27, REF_GEOM);
    const translates = ops.filter((o) => o.op === "translate");
    expect(translates).toEqual([{ op: "translate", x: PAD, y: PAD }]);
  });

  it("repaints the background so a reused canvas cannot smear through the slashes", () => {
    const { ops, ctx } = recorder();
    drawShutterFrame(ctx, PHOTO, 27, REF_GEOM);
    const first = ops[0];
    expect(first).toEqual({ op: "fillRect", args: [0, 0, CANVAS_W, CANVAS_H] });
    expect(ctx.fillStyle).toBe(BG);
  });

  it("balances save/restore, so a caller's own clip survives the call", () => {
    const { ops, ctx } = recorder();
    drawShutterFrame(ctx, PHOTO, 27, REF_GEOM);
    let depth = 0;
    for (const o of ops) {
      if (o.op === "save") depth += 1;
      if (o.op === "restore") depth -= 1;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });
});

/* ------------------------------------------------------------------------------------- */
/* The wordmark                                                                            */
/* ------------------------------------------------------------------------------------- */

const REF_NAME = "Jonathan Naal";
const REF_LAYOUT = nameLayout(REF_NAME);

describe("the typewriter", () => {
  it("reproduces the reference schedule", () => {
    expect(REF_LAYOUT.text).toBe("JONATHAN NAAL");
    expect(REF_LAYOUT.x0).toBeCloseTo((NAME_W - 13 * STEP) / 2, 10);
    expect(REF_LAYOUT.deleteEnd).toBe(31);
    expect(REF_LAYOUT.typeAt[0]).toBe(38);
  });

  it("shows the finished name at frame 0 and at the end of the loop", () => {
    expect(visibleCount(0, REF_LAYOUT)).toBe(REF_LAYOUT.text.length);
    expect(visibleCount(LOOP - 1, REF_LAYOUT)).toBe(REF_LAYOUT.text.length);
  });

  it("empties the line before retyping it, and never goes out of bounds", () => {
    const len = REF_LAYOUT.text.length;
    for (const f of FRAMES) {
      const c = visibleCount(f, REF_LAYOUT);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(len);
    }
    expect(visibleCount(REF_LAYOUT.deleteEnd, REF_LAYOUT)).toBe(0);
    expect(visibleCount(37, REF_LAYOUT)).toBe(0);
  });

  it("deletes monotonically and types monotonically", () => {
    for (let f = 18; f < REF_LAYOUT.deleteEnd; f += 1) {
      expect(visibleCount(f + 1, REF_LAYOUT)).toBeLessThanOrEqual(visibleCount(f, REF_LAYOUT));
    }
    for (let f = 38; f < LOOP - 1; f += 1) {
      expect(visibleCount(f + 1, REF_LAYOUT)).toBeGreaterThanOrEqual(visibleCount(f, REF_LAYOUT));
    }
  });

  it("jitters each keystroke by 2 to 4 frames — irregular, but deterministic", () => {
    const gaps = REF_LAYOUT.typeAt.slice(1).map((t, i) => t - REF_LAYOUT.typeAt[i]);
    for (const g of gaps) {
      expect(g).toBeGreaterThanOrEqual(2);
      expect(g).toBeLessThanOrEqual(4);
    }
    expect(new Set(gaps).size).toBeGreaterThan(1); // not a metronome
    expect(nameLayout(REF_NAME)).toEqual(REF_LAYOUT); // same twice
    expect(noise(3, 7)).toBe(noise(3, 7));
  });

  it("finishes typing well inside the loop, for any name the grid accepts", () => {
    const longest = nameLayout("A".repeat(MAX_NAME_CHARS));
    expect(longest.typeEnd).toBeLessThan(LOOP);
    expect(longest.typeEnd).toBeLessThanOrEqual(94); // 38 + 13·4 + 4, the worst case
  });

  it("holds the caret steady while typing and blinks it when idle", () => {
    expect(caretVisible(0, REF_LAYOUT)).toBe(true);
    for (let f = 18; f < REF_LAYOUT.typeEnd; f += 1) {
      expect(caretVisible(f, REF_LAYOUT)).toBe(true);
    }
    const idle = FRAMES.slice(REF_LAYOUT.typeEnd).map((f) => caretVisible(f, REF_LAYOUT));
    expect(new Set(idle).size).toBe(2); // it does blink
  });
});

describe("nameFitsGrid", () => {
  it("accepts a name that fits the monospace grid", () => {
    expect(nameFitsGrid("Jonathan Naal")).toBe(true);
    expect(nameFitsGrid("José García")).toBe(true);
    expect(nameFitsGrid("Anne-Marie")).toBe(true);
    expect(nameFitsGrid("O'Dea")).toBe(true);
    expect(nameFitsGrid("A".repeat(MAX_NAME_CHARS))).toBe(true);
  });

  it("rejects anything the grid would misplace, so the caller falls back to live text", () => {
    expect(nameFitsGrid("A".repeat(MAX_NAME_CHARS + 1))).toBe(false);
    expect(nameFitsGrid("")).toBe(false);
    expect(nameFitsGrid("   ")).toBe(false);
    expect(nameFitsGrid("山田太郎")).toBe(false); // double-width
    expect(nameFitsGrid("Ада Лавлейс")).toBe(false); // not Latin
    expect(nameFitsGrid("Jon 🚀")).toBe(false);
    expect(nameFitsGrid("42 Jonathan")).toBe(false);
  });

  it("counts the string that is actually drawn, after upper-casing", () => {
    // ß → SS: thirteen characters become fourteen, and one more would overflow.
    expect("Straßenstraß".toUpperCase().length).toBe(14);
    expect(nameFitsGrid("Straßenstraß")).toBe(true);
    expect(nameFitsGrid("Straßenstraße")).toBe(false);
  });

  it("guarantees the caret stays on canvas for every accepted name", () => {
    for (let n = 1; n <= MAX_NAME_CHARS; n += 1) {
      const l = nameLayout("A".repeat(n));
      expect(l.x0).toBeGreaterThanOrEqual(0);
      // Caret parks after the last glyph; CARET_W is 10.
      expect(l.x0 + n * STEP + 10).toBeLessThanOrEqual(NAME_W);
    }
  });
});

describe("drawNameFrame", () => {
  const layoutOf = (l: NameLayout, frame: number) => {
    const { ops, ctx } = recorder();
    drawNameFrame(ctx, frame, l, '"Geist Mono", monospace');
    return ops;
  };

  it("puts every glyph on the STEP grid and skips the space", () => {
    const ops = layoutOf(REF_LAYOUT, 0);
    const glyphs = ops.filter((o) => o.op === "fillText");
    expect(glyphs.map((g) => g.char).join("")).toBe("JONATHANNAAL"); // no space drawn
    // Centred in its own STEP-wide cell, exactly as the DOM version's text-align: center was.
    const jIndex = 0;
    expect(glyphs[jIndex].x).toBeCloseTo(REF_LAYOUT.x0 + STEP / 2, 10);
    const lastIndex = REF_LAYOUT.text.length - 1;
    expect(glyphs[glyphs.length - 1].x).toBeCloseTo(REF_LAYOUT.x0 + lastIndex * STEP + STEP / 2, 10);
  });

  it("centres the baseline the way CSS line-height did", () => {
    const ops = layoutOf(REF_LAYOUT, 0);
    const g = ops.find((o) => o.op === "fillText");
    // ascent 28, descent 8 from the stub: half-leading (56 − 36)/2 = 10, baseline at 38.
    expect(g?.y).toBeCloseTo(10 + 28, 10);
  });

  it("parks the caret after the last visible glyph", () => {
    for (const f of [0, 24, 40, 109]) {
      const ops = layoutOf(REF_LAYOUT, f);
      const rects = ops.filter((o) => o.op === "fillRect");
      const bg = rects[0];
      expect(bg.args).toEqual([0, 0, NAME_W, NAME_H]);
      if (caretVisible(f, REF_LAYOUT)) {
        const caret = rects[1];
        expect(caret.args[0]).toBeCloseTo(
          REF_LAYOUT.x0 + visibleCount(f, REF_LAYOUT) * STEP,
          10,
        );
        expect(caret.args[1] + caret.args[3]).toBeLessThanOrEqual(NAME_H);
      } else {
        expect(rects).toHaveLength(1);
      }
    }
  });

  it("takes the font family from its caller rather than hardcoding one", () => {
    const { ctx } = recorder();
    drawNameFrame(ctx, 0, REF_LAYOUT, '"Fira Code", monospace');
    expect(ctx.font).toContain('"Fira Code", monospace');
    expect(ctx.font).toContain("30px");
  });
});
