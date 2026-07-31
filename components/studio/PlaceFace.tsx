"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PHOTO_H, solve, type Landmarks, type Solution } from "@/lib/geometry";

interface Props {
  photo: ImageBitmap;
  width: number;
  height: number;
  landmarks: Landmarks;
  onChange: (l: Landmarks) => void;
  solution: Solution;
  autoPlaced: boolean;
}

type Handle = "brow" | "chin" | "centre";

/**
 * Step 2 — where the user tells us where their face is.
 *
 * This is the screen the whole product rests on. `lib/geometry` can solve a band layout for any
 * face, but only if it is told the truth about two points, and a stranger has no reason to care
 * about band overlaps. So the screen never explains the geometry: it SHOWS the consequence.
 *
 * The shaded strip is the region every band displays. If a guide leaves the face outside it, a
 * band edge will cut across the face in the finished animation — so the strip is drawn on the
 * photograph itself, live, and the user sees the problem while they are causing it rather than
 * four steps later.
 *
 * Everything draggable is also a real focusable control with arrow-key handling. A drag-only
 * positioner would make this the one screen a keyboard user cannot complete, and there is no
 * alternate route to the same outcome.
 */
export default function PlaceFace({
  photo,
  width,
  height,
  landmarks,
  onChange,
  solution,
  autoPlaced,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dragging, setDragging] = useState<Handle | null>(null);

  // The photograph, painted once per photo. Guides are DOM on top rather than more canvas, so
  // they can be focused, labelled and read by a screen reader.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = width;
    c.height = height;
    c.getContext("2d")?.drawImage(photo, 0, 0);
  }, [photo, width, height]);

  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

  const move = useCallback(
    (handle: Handle, clientX: number, clientY: number) => {
      const box = boxRef.current?.getBoundingClientRect();
      if (!box) return;
      const fx = clamp01((clientX - box.left) / box.width);
      const fy = clamp01((clientY - box.top) / box.height);
      if (handle === "centre") onChange({ ...landmarks, faceCx: fx });
      else if (handle === "brow") onChange({ ...landmarks, browY: fy });
      else onChange({ ...landmarks, chinY: fy });
    },
    [landmarks, onChange],
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => move(dragging, e.clientX, e.clientY);
    const onUp = () => setDragging(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, move]);

  const nudge = (handle: Handle, delta: number) => {
    if (handle === "centre") onChange({ ...landmarks, faceCx: clamp01(landmarks.faceCx + delta) });
    else if (handle === "brow") onChange({ ...landmarks, browY: clamp01(landmarks.browY + delta) });
    else onChange({ ...landmarks, chinY: clamp01(landmarks.chinY + delta) });
  };

  const onKey = (handle: Handle) => (e: React.KeyboardEvent) => {
    const axis = handle === "centre" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    if (!axis.includes(e.key)) return;
    e.preventDefault();
    const step = e.shiftKey ? 0.02 : 0.004;
    nudge(handle, e.key === axis[0] ? -step : step);
  };

  // The safe strip lives in PHOTO space; to draw it on the SOURCE photograph it has to travel
  // back through the crop that produced it.
  const { crop, geom, placed } = solution;
  const toFrac = (photoY: number) => (crop.y + (photoY / PHOTO_H) * crop.h) / height;
  const safeTop = toFrac(geom.overlap.top);
  const safeBottom = toFrac(geom.overlap.bottom);

  const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
  const cropStyle = {
    left: pct(crop.x / width),
    top: pct(crop.y / height),
    width: pct(crop.w / width),
    height: pct(crop.h / height),
  };

  const cut =
    placed.chin > geom.overlap.bottom || placed.hairTop < geom.overlap.top || !solution.ok;

  return (
    <div className="grid gap-8 md:grid-cols-[1fr_auto] md:items-start">
      <div>
        <div
          ref={boxRef}
          className="relative select-none overflow-hidden border border-line bg-paper"
          style={{ aspectRatio: `${width} / ${height}` }}
        >
          <canvas ref={canvasRef} className="block h-full w-full" />

          {/* Everything outside the crop is dimmed rather than hidden: seeing what is being
              discarded is what makes the framing legible. */}
          <div className="pointer-events-none absolute inset-0 bg-white/55" />
          <div
            className="pointer-events-none absolute overflow-hidden"
            style={cropStyle}
            aria-hidden
          >
            <canvas
              className="absolute block"
              style={{
                width: pct(width / crop.w),
                height: pct(height / crop.h),
                left: pct(-crop.x / crop.w),
                top: pct(-crop.y / crop.h),
              }}
              ref={(el) => {
                if (!el) return;
                el.width = width;
                el.height = height;
                el.getContext("2d")?.drawImage(photo, 0, 0);
              }}
            />
          </div>
          <div
            className="pointer-events-none absolute border border-ink"
            style={cropStyle}
            aria-hidden
          />

          {/* The band overlap. Outside this strip, a band edge crosses the face. */}
          <div
            className={`pointer-events-none absolute left-0 right-0 border-y border-dashed ${
              cut ? "border-ink bg-ink/15" : "border-ink/40 bg-ink/[0.06]"
            }`}
            style={{ top: pct(safeTop), height: pct(safeBottom - safeTop) }}
            aria-hidden
          />

          {(["brow", "chin"] as const).map((h) => {
            const y = h === "brow" ? landmarks.browY : landmarks.chinY;
            return (
              <button
                key={h}
                type="button"
                onPointerDown={(e) => {
                  e.preventDefault();
                  setDragging(h);
                }}
                onKeyDown={onKey(h)}
                aria-label={h === "brow" ? "Eye line" : "Bottom of chin"}
                aria-valuenow={Math.round(y * 100)}
                role="slider"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-orientation="vertical"
                className="absolute left-0 right-0 flex h-6 -translate-y-1/2 cursor-ns-resize items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-ink"
                style={{ top: pct(y) }}
              >
                <span className="h-px w-full bg-ink" />
                <span className="absolute left-2 bg-ink px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-white mono">
                  {h === "brow" ? "eyes" : "chin"}
                </span>
              </button>
            );
          })}

          <button
            type="button"
            onPointerDown={(e) => {
              e.preventDefault();
              setDragging("centre");
            }}
            onKeyDown={onKey("centre")}
            aria-label="Centre of face"
            role="slider"
            aria-valuenow={Math.round(landmarks.faceCx * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="absolute bottom-0 top-0 w-6 -translate-x-1/2 cursor-ew-resize focus:outline-none focus-visible:ring-2 focus-visible:ring-ink"
            style={{ left: pct(landmarks.faceCx) }}
          >
            <span className="mx-auto block h-full w-px bg-ink" />
          </button>
        </div>

        <p className="mt-3 text-[13px] leading-relaxed text-mute">
          Drag the two lines onto your eyes and the bottom of your chin.{" "}
          {autoPlaced
            ? "They were placed automatically — move them if they are off."
            : "We could not find a face, so they start in the middle."}{" "}
          The shaded strip is what every band of the animation shows; keep your face inside it.
        </p>
      </div>

      <div className="md:w-[300px]">
        <p className="stamp">Resting frame</p>
        <div className="mt-3 inline-block border border-line bg-white p-4">
          <PreviewSlot />
        </div>
        {cut ? (
          <p className="mt-4 border-l-2 border-ink pl-3 text-[13px] leading-relaxed text-ink">
            {solution.warnings.includes("cannot-frame")
              ? "This photo cannot be framed without cutting your face — there is not enough room above your head, or your face fills too much of the picture. Try one with more space around it."
              : "A band edge is crossing your face. Move the lines, or use a photo with more room around your head."}
          </p>
        ) : (
          <p className="mt-4 text-[13px] leading-relaxed text-mute">
            This is the still your recipients see in Outlook 2016 and on Mac — the animation
            rests here, so it is never a blank.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Filled by the parent through a portal-free convention: the parent owns the encoder, so it
 * paints into this canvas by id. Keeping the worker in one place is worth the small indirection.
 */
function PreviewSlot() {
  return (
    <canvas
      id="studio-preview"
      width={224}
      height={276}
      className="block h-[276px] w-[224px]"
      aria-label="Preview of the resting frame"
    />
  );
}
