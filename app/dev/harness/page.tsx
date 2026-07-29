"use client";

/**
 * /dev/harness — the first end-to-end run of the pipeline, and the only place it is measured
 * against the render that was signed off.
 *
 * Everything upstream of this page has been proven as pure functions: the geometry solves, the
 * grade matches ffmpeg's plane to a mean of 0.17, the muxer round-trips through an independent
 * decoder. None of that involves a rasteriser. `drawShutterFrame` clips five leaning
 * parallelograms per frame, and browser clip antialiasing is not swscale's — so the interesting
 * question is not "does it run" but "how far has it drifted, and where does the drift live".
 *
 * The page therefore reports TWO diffs against the reference GIF:
 *
 *   postQuant — our finished GIF, decoded, versus the reference GIF, decoded.
 *   preQuant  — our RAW rendered frames, before the palette and the dither, versus the same.
 *
 * That pair is the diagnostic. If preQuant is small and postQuant is large, the gap is the
 * palette search and the Bayer dither. If both are large the gap is upstream — antialiasing
 * along the band edges, or geometry, or a genuine bug — and the per-frame chart says which,
 * because a geometry error is constant across the loop while an animation error tracks it.
 *
 * DEV ONLY. It depends on /api/fixture/*, which is 404 in production, and it holds ~80 MB of
 * decoded frames while it works.
 */

import { useEffect, useRef, useState } from "react";
import { solve, REFERENCE, PHOTO_W, PHOTO_H, CANVAS_W, CANVAS_H } from "@/lib/geometry";
import { grade } from "@/lib/grade";
import { drawShutterFrame, LOOP, FPS } from "@/lib/render";
import { encodeGif } from "@/lib/gif";
import { decodeGif, diffRgba, type FrameDiff } from "@/lib/gif/decode";

const DELAY_CS = 4;
const MAX_COLORS = 24;
const REFERENCE_BYTES = 69_944;

interface GifFacts {
  bytes: number;
  width: number;
  height: number;
  frames: number;
  delayCs: number | "mixed";
  loopCount: number | null;
  paletteEntries: number;
  greyLevels: number;
  /** Frames the encoder emitted as a 1x1 no-op — the hold, and most of the file's savings. */
  holdFrames: number;
  /** Bytes of LZW payload in frame 0 alone. */
  frame0DataBytes: number;
}

interface Report {
  ok: boolean;
  error?: string;
  source: { w: number; h: number };
  geometry: {
    crop: { x: number; y: number; w: number; h: number };
    cropRounded: { x: number; y: number; w: number; h: number };
    expectedCrop: { x: number; y: number; w: number; h: number };
    cropMatches: boolean;
    rest: number;
    windowH: number;
    restMatches: boolean;
    warnings: string[];
    solveOk: boolean;
  };
  ours: GifFacts;
  reference: GifFacts;
  byteRatio: number;
  framesCompared: number;
  /** Our GIF decoded vs the reference GIF decoded. */
  postQuant: { overall: FrameDiff; perFrame: FrameDiff[]; worst: { frame: number; mean: number }[] };
  /** Our raw rendered frames vs the reference GIF decoded — the palette-free comparison. */
  preQuant: { overall: FrameDiff; perFrame: FrameDiff[] };
  /** Frame 0 must be a complete resting picture: Outlook 2016/2019 renders nothing else. */
  loop: { frame0EqualsLast: boolean; frame0MaxVsLast: number };
  palettes: { ours: number[]; reference: number[] };
  timings: {
    fetchDecodeSourceMs: number;
    gradeMs: number;
    renderMs: number;
    encodeMs: number;
    pipelineMs: number;
    diffMs: number;
    totalMs: number;
  };
}

const round = (v: number, n = 3): number => Number(v.toFixed(n));

function facts(bytes: Uint8Array): GifFacts {
  const g = decodeGif(bytes);
  const delays = new Set(g.frames.map((f) => f.delayCs));
  const greys = new Set<number>();
  for (const f of g.frames) {
    for (let i = 0; i < f.rgba.length; i += 4) greys.add(f.rgba[i]);
  }
  return {
    bytes: bytes.length,
    width: g.width,
    height: g.height,
    frames: g.frames.length,
    delayCs: delays.size === 1 ? [...delays][0] : "mixed",
    loopCount: g.loopCount,
    paletteEntries: g.globalPaletteSize,
    greyLevels: greys.size,
    holdFrames: g.frames.filter((f) => f.rect.w === 1 && f.rect.h === 1).length,
    frame0DataBytes: g.frames[0]?.dataBytes ?? 0,
  };
}

function aggregate(parts: FrameDiff[]): FrameDiff {
  if (parts.length === 0) return { mean: 0, max: 0, pctOver2: 0 };
  // Every frame is the same full canvas, so a plain average of the per-frame means is exactly
  // the mean over all pixels of all frames. No weighting needed, and none hidden either.
  let mean = 0;
  let pct = 0;
  let max = 0;
  for (const p of parts) {
    mean += p.mean;
    pct += p.pctOver2;
    if (p.max > max) max = p.max;
  }
  return { mean: mean / parts.length, max, pctOver2: pct / parts.length };
}

function greyLevelsOf(palette: Uint8Array, size: number): number[] {
  const seen = new Set<number>();
  for (let i = 0; i < size; i += 1) seen.add(palette[3 * i]);
  return [...seen].sort((a, b) => a - b);
}

async function run(setPhase: (p: string) => void): Promise<{ report: Report; gif: Uint8Array }> {
  const tStart = performance.now();

  /* ---- 1. the source photograph ------------------------------------------------------- */
  setPhase("fetching source-portrait.png");
  const res = await fetch("/api/fixture/source-portrait.png", { cache: "no-store" });
  if (!res.ok) throw new Error(`fixture source-portrait.png: HTTP ${res.status}`);

  // colorSpaceConversion "none" is not a micro-optimisation. The grade was reverse-engineered
  // against ffmpeg, which reads the PNG's samples verbatim; letting the browser apply an
  // embedded ICC profile would shift every luma value before a single filter had run, and the
  // whole diff below would be measuring Chrome's colour management instead of our pipeline.
  const bitmap = await createImageBitmap(await res.blob(), {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });

  const src = readback(bitmap.width, bitmap.height, (ctx) => ctx.drawImage(bitmap, 0, 0));
  bitmap.close();
  const fetchDecodeSourceMs = performance.now() - tStart;

  /* ---- 2. geometry --------------------------------------------------------------------- */
  const sol = solve({ w: src.width, h: src.height }, REFERENCE.landmarks);
  const cropRounded = {
    x: Math.round(sol.crop.x),
    y: Math.round(sol.crop.y),
    w: Math.round(sol.crop.w),
    h: Math.round(sol.crop.h),
  };
  const exp = REFERENCE.expectedCrop;

  /* ---- 3. grade ------------------------------------------------------------------------ */
  setPhase("grading");
  const tGrade = performance.now();
  const graded = grade(src, sol.crop, PHOTO_W, PHOTO_H);
  const gradeMs = performance.now() - tGrade;

  const photo = new OffscreenCanvas(PHOTO_W, PHOTO_H);
  context2d(photo).putImageData(graded, 0, 0);

  /* ---- 4. render ----------------------------------------------------------------------- */
  setPhase(`rendering ${LOOP} frames`);
  const tRender = performance.now();
  const canvas = new OffscreenCanvas(CANVAS_W, CANVAS_H);
  const ctx = context2d(canvas, true);
  const rendered: ImageData[] = [];
  for (let f = 0; f < LOOP; f += 1) {
    drawShutterFrame(ctx, photo, f, sol.geom);
    rendered.push(ctx.getImageData(0, 0, CANVAS_W, CANVAS_H));
  }
  const renderMs = performance.now() - tRender;

  /* ---- 5. encode ----------------------------------------------------------------------- */
  setPhase("encoding gif");
  const tEncode = performance.now();
  const gif = encodeGif(rendered, {
    width: CANVAS_W,
    height: CANVAS_H,
    delayCs: DELAY_CS,
    maxColors: MAX_COLORS,
    dither: "bayer",
  });
  const encodeMs = performance.now() - tEncode;
  const pipelineMs = gradeMs + renderMs + encodeMs;

  /* ---- 6. diff against the render that was signed off ---------------------------------- */
  setPhase("diffing against reference-sig-a.gif");
  const tDiff = performance.now();

  const refRes = await fetch("/api/fixture/reference-sig-a.gif", { cache: "no-store" });
  if (!refRes.ok) throw new Error(`fixture reference-sig-a.gif: HTTP ${refRes.status}`);
  const refBytes = new Uint8Array(await refRes.arrayBuffer());

  const oursDecoded = decodeGif(gif);
  const refDecoded = decodeGif(refBytes);

  if (oursDecoded.width !== refDecoded.width || oursDecoded.height !== refDecoded.height) {
    throw new Error(
      `canvas mismatch: ours ${oursDecoded.width}x${oursDecoded.height}, ` +
        `reference ${refDecoded.width}x${refDecoded.height}`,
    );
  }

  const framesCompared = Math.min(oursDecoded.frames.length, refDecoded.frames.length);
  const post: FrameDiff[] = [];
  const pre: FrameDiff[] = [];
  for (let i = 0; i < framesCompared; i += 1) {
    const ref = refDecoded.frames[i].rgba;
    post.push(diffRgba(oursDecoded.frames[i].rgba, ref));
    // Uint8ClampedArray from ImageData; diffRgba only indexes, so no copy is needed.
    pre.push(diffRgba(rendered[i].data, ref));
  }

  const last = oursDecoded.frames[oursDecoded.frames.length - 1];
  const loopDiff = diffRgba(oursDecoded.frames[0].rgba, last.rgba);
  const diffMs = performance.now() - tDiff;

  const worst = post
    .map((d, frame) => ({ frame, mean: round(d.mean, 4) }))
    .sort((a, b) => b.mean - a.mean)
    .slice(0, 6);

  const report: Report = {
    ok: true,
    source: { w: src.width, h: src.height },
    geometry: {
      crop: {
        x: round(sol.crop.x, 4),
        y: round(sol.crop.y, 4),
        w: round(sol.crop.w, 4),
        h: round(sol.crop.h, 4),
      },
      cropRounded,
      expectedCrop: { ...exp },
      cropMatches:
        cropRounded.x === exp.x &&
        cropRounded.y === exp.y &&
        cropRounded.w === exp.w &&
        cropRounded.h === exp.h,
      rest: sol.geom.rest,
      windowH: sol.geom.windowH,
      restMatches:
        sol.geom.rest === REFERENCE.expectedRest &&
        sol.geom.windowH === REFERENCE.expectedWindowH,
      warnings: [...sol.warnings],
      solveOk: sol.ok,
    },
    ours: facts(gif),
    reference: facts(refBytes),
    byteRatio: round(gif.length / REFERENCE_BYTES, 4),
    framesCompared,
    postQuant: {
      overall: roundDiff(aggregate(post)),
      perFrame: post.map(roundDiff),
      worst,
    },
    preQuant: {
      overall: roundDiff(aggregate(pre)),
      perFrame: pre.map(roundDiff),
    },
    loop: { frame0EqualsLast: loopDiff.max === 0, frame0MaxVsLast: loopDiff.max },
    palettes: {
      ours: greyLevelsOf(oursDecoded.globalPalette, oursDecoded.globalPaletteSize),
      reference: greyLevelsOf(refDecoded.globalPalette, refDecoded.globalPaletteSize),
    },
    timings: {
      fetchDecodeSourceMs: round(fetchDecodeSourceMs, 1),
      gradeMs: round(gradeMs, 1),
      renderMs: round(renderMs, 1),
      encodeMs: round(encodeMs, 1),
      pipelineMs: round(pipelineMs, 1),
      diffMs: round(diffMs, 1),
      totalMs: round(performance.now() - tStart, 1),
    },
  };

  return { report, gif };
}

const roundDiff = (d: FrameDiff): FrameDiff => ({
  mean: round(d.mean, 4),
  max: d.max,
  pctOver2: round(d.pctOver2, 4),
});

function context2d(c: OffscreenCanvas, readFrequently = false): OffscreenCanvasRenderingContext2D {
  const ctx = c.getContext("2d", { willReadFrequently: readFrequently });
  if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");
  return ctx;
}

/** Draw into a throwaway canvas and read the pixels back out as ImageData. */
function readback(
  w: number,
  h: number,
  draw: (ctx: OffscreenCanvasRenderingContext2D) => void,
): ImageData {
  const c = new OffscreenCanvas(w, h);
  const ctx = context2d(c, true);
  draw(ctx);
  return ctx.getImageData(0, 0, w, h);
}

/* ================================================================================ view ==== */

export default function HarnessPage() {
  const [phase, setPhase] = useState("starting");
  const [report, setReport] = useState<Report | null>(null);
  const [ourUrl, setOurUrl] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // React 19 runs effects twice in development. The pipeline takes seconds and allocates
    // ~80 MB; running it twice concurrently is how this page ends up looking like a bug.
    if (started.current) return;
    started.current = true;

    let url: string | null = null;
    void (async () => {
      try {
        // Mirrored to the console as well as the DOM. When this page stalls, the DOM only ever
        // shows the LAST phase that committed, which cannot distinguish "hung inside step 3"
        // from "never started" — and that difference is the whole diagnosis. The console keeps
        // the ordering and the timestamps, and Playwright can read it.
        const trace = (p: string) => {
          console.log(`[harness] ${Math.round(performance.now())}ms ${p}`);
          setPhase(p);
        };
        trace("effect running");
        const { report: r, gif } = await run(trace);
        // Copied into a plain ArrayBuffer-backed view: Blob rejects a possibly-shared buffer,
        // and 70 KB is not worth an assertion that would outlive the reason for it.
        url = URL.createObjectURL(new Blob([new Uint8Array(gif)], { type: "image/gif" }));
        setOurUrl(url);
        setReport(r);
        setPhase("done");
      } catch (err) {
        setPhase("failed");
        setReport({
          ok: false,
          error: err instanceof Error ? `${err.message}` : String(err),
        } as Report);
      }
    })();

    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, []);

  // Mirrors the gate on /api/fixture. This one has to be a NEXT_PUBLIC_ variable because the
  // check runs in the browser, and Next inlines only that prefix into the client bundle — a
  // bare process.env.HARNESS_ROUTES would read as undefined here and hide the page from itself.
  if (
    process.env.NODE_ENV === "production" &&
    process.env.NEXT_PUBLIC_HARNESS !== "1"
  ) {
    return <main className="p-10 mono text-sm">Not available.</main>;
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <p className="stamp">dev / harness</p>
      <h1 className="mt-3 text-3xl tracking-tight">End-to-end render diff</h1>
      <p className="mt-4 max-w-2xl text-sm leading-relaxed text-ink-3">
        Grades the reference portrait, renders {LOOP} frames at {FPS} fps, encodes a GIF at{" "}
        {MAX_COLORS} colours with Bayer dither, and diffs it against the {REFERENCE_BYTES}
        -byte file ffmpeg produced from the same photograph.
      </p>

      <div className="mt-10 border-t border-line pt-4">
        <p className="mono text-xs text-mute">
          {report ? (report.ok ? "complete" : "failed") : phase}
          {!report && <span className="caret ml-1 align-baseline" />}
        </p>
      </div>

      {report?.ok && <Summary report={report} />}
      {report?.ok && ourUrl && <SideBySide ourUrl={ourUrl} />}
      {report?.ok && <Charts report={report} />}

      {report && (
        <section className="mt-16">
          <h2 className="stamp">raw result</h2>
          <pre
            id="harness-result"
            className="mt-3 overflow-x-auto border border-line bg-paper p-4 mono text-[11px] leading-relaxed text-ink-2"
          >
            {JSON.stringify(report, null, 2)}
          </pre>
        </section>
      )}
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-b border-line py-2">
      <span className="text-sm text-ink-3">{label}</span>
      <span className="mono text-sm text-ink tabular-nums">{value}</span>
    </div>
  );
}

function Summary({ report: r }: { report: Report }) {
  const t = r.timings;
  return (
    <section className="mt-12 grid gap-x-12 gap-y-0 md:grid-cols-2">
      <div>
        <h2 className="stamp mb-3">difference</h2>
        <Row label="mean absolute (0-255)" value={r.postQuant.overall.mean.toFixed(4)} />
        <Row label="max absolute" value={String(r.postQuant.overall.max)} />
        <Row label="pixels differing by > 2" value={`${r.postQuant.overall.pctOver2.toFixed(3)} %`} />
        <Row label="before palette / dither, mean" value={r.preQuant.overall.mean.toFixed(4)} />
        <Row label="before palette / dither, max" value={String(r.preQuant.overall.max)} />
        <Row label="frames compared" value={String(r.framesCompared)} />
      </div>
      <div>
        <h2 className="stamp mb-3">file</h2>
        <Row label="our bytes" value={r.ours.bytes.toLocaleString("en")} />
        <Row label="reference bytes" value={r.reference.bytes.toLocaleString("en")} />
        <Row label="ratio" value={`${r.byteRatio.toFixed(3)} x`} />
        <Row label="frames" value={`${r.ours.frames} / ${r.reference.frames}`} />
        <Row label="delay (cs)" value={`${r.ours.delayCs} / ${r.reference.delayCs}`} />
        <Row
          label="loop"
          value={`${loopWord(r.ours.loopCount)} / ${loopWord(r.reference.loopCount)}`}
        />
        <Row label="grey levels" value={`${r.ours.greyLevels} / ${r.reference.greyLevels}`} />
      </div>

      <div className="mt-10">
        <h2 className="stamp mb-3">geometry</h2>
        <Row
          label="crop"
          value={`${r.geometry.cropRounded.x}, ${r.geometry.cropRounded.y} · ${r.geometry.cropRounded.w} x ${r.geometry.cropRounded.h}`}
        />
        <Row label="matches reference crop" value={r.geometry.cropMatches ? "yes" : "NO"} />
        <Row label="rest / windowH" value={`${r.geometry.rest} / ${r.geometry.windowH}`} />
        <Row label="warnings" value={r.geometry.warnings.join(", ") || "none"} />
        <Row label="frame 0 = last frame" value={r.loop.frame0EqualsLast ? "yes" : "NO"} />
      </div>
      <div className="mt-10">
        <h2 className="stamp mb-3">wall clock</h2>
        <Row label="fetch + decode source" value={`${t.fetchDecodeSourceMs} ms`} />
        <Row label="grade" value={`${t.gradeMs} ms`} />
        <Row label="render" value={`${t.renderMs} ms`} />
        <Row label="encode" value={`${t.encodeMs} ms`} />
        <Row label="grade + render + encode" value={`${t.pipelineMs} ms`} />
        <Row label="diff" value={`${t.diffMs} ms`} />
      </div>
    </section>
  );
}

const loopWord = (n: number | null): string =>
  n === null ? "absent" : n === 0 ? "forever" : `${n} x`;

function SideBySide({ ourUrl }: { ourUrl: string }) {
  return (
    <section className="mt-16">
      <h2 className="stamp">side by side</h2>
      <div className="mt-4 flex flex-wrap gap-10">
        {[
          { src: ourUrl, label: "ours — canvas + this encoder" },
          { src: "/api/fixture/reference-sig-a.gif", label: "reference — ffmpeg" },
        ].map((g) => (
          <figure key={g.label}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={g.src}
              alt={g.label}
              width={CANVAS_W}
              height={CANVAS_H}
              className="border border-line"
            />
            <figcaption className="mono mt-2 text-xs text-mute">{g.label}</figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}

/**
 * Three sparklines rather than one chart with three series: the mean sits near 1, the max near
 * 100 and the percentage anywhere between. Sharing an axis would flatten two of them into the
 * baseline, and the shape over the loop is the entire point — a flat line means a constant
 * error (geometry, grade), a bump between frames 12 and 54 means the animation.
 */
function Charts({ report }: { report: Report }) {
  return (
    <section className="mt-16">
      <h2 className="stamp">per frame</h2>
      <div className="mt-4 space-y-8">
        <Spark
          label="mean absolute difference"
          values={report.postQuant.perFrame.map((d) => d.mean)}
        />
        <Spark label="max absolute difference" values={report.postQuant.perFrame.map((d) => d.max)} />
        <Spark
          label="% of pixels differing by more than 2"
          values={report.postQuant.perFrame.map((d) => d.pctOver2)}
        />
        <Spark
          label="mean, before palette and dither"
          values={report.preQuant.perFrame.map((d) => d.mean)}
        />
      </div>
    </section>
  );
}

function Spark({ label, values }: { label: string; values: number[] }) {
  const W = 900;
  const H = 90;
  const top = Math.max(...values, Number.EPSILON);
  const bw = W / values.length;

  return (
    <figure>
      <figcaption className="mono mb-2 flex justify-between text-xs text-mute">
        <span>{label}</span>
        <span className="text-ink-3">peak {top.toFixed(top < 10 ? 3 : 1)}</span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full border-b border-line"
        role="img"
        aria-label={label}
      >
        {values.map((v, i) => (
          <rect
            key={i}
            x={i * bw}
            y={H - (v / top) * H}
            width={Math.max(bw - 1, 0.5)}
            height={(v / top) * H}
            fill="#0a0a0a"
          />
        ))}
      </svg>
      <div className="mono mt-1 flex justify-between text-[10px] text-mute-2">
        <span>frame 0</span>
        <span>{values.length - 1}</span>
      </div>
    </figure>
  );
}
