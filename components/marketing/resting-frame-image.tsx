"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

const readPreference = (): boolean => window.matchMedia(QUERY).matches;

/** The server cannot know the preference, so it renders the animated branch and the class
 *  below keeps it hidden for reduced-motion visitors until hydration decides. */
const serverPreference = (): boolean => false;

/**
 * Freezes the GIF by drawing it to a canvas and reading the pixels back as a PNG.
 *
 * There is no way to pause a GIF from CSS or from the DOM, and no still frame is hosted next
 * to it, so the still has to be manufactured from the animation itself. Two facts make that
 * safe here rather than a race: the image is decoded but never inserted into the document, so
 * its animation clock has not started when drawImage samples it; and this GIF holds its
 * resting state for the first twelve frames (SCATTER_START in lib/render.ts), which is 480ms
 * of identical pixels even if a browser did start the clock early. Either way what lands on
 * the canvas is the resting state — the same frame Outlook 2016 shows.
 */
async function restingFrame(src: string): Promise<string> {
  const img = new Image();
  // Set before src: a hosted signature will be on another origin, and without the CORS
  // request the canvas is tainted and toDataURL throws instead of returning a still.
  img.crossOrigin = "anonymous";
  img.src = src;
  await img.decode();

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(img, 0, 0);
  return canvas.toDataURL("image/png");
}

export interface RestingFrameImageProps {
  /** Absolute or root-relative URL of the animated GIF. */
  src: string;
  /** Optional pre-rendered still. Given one, no canvas work happens at all. */
  stillSrc?: string;
  width: number;
  height: number;
  alt: string;
}

/**
 * The animated signature, rendered so that a visitor who asked for reduced motion never sees
 * it move. They get the resting frame; everyone else gets the loop.
 *
 * The wrapper carries the class, not the <img>: the image keeps the exact inline styles of the
 * exported signature markup, and an inline `display:block` would beat the utility's
 * `display:none`. If the freeze fails (a tainted canvas, an image that will not decode) the
 * wrapper stays hidden for those visitors rather than falling back to the animation — the
 * preference is not a preference we get to overrule.
 */
export function RestingFrameImage({
  src,
  stillSrc,
  width,
  height,
  alt,
}: RestingFrameImageProps) {
  const reduce = useSyncExternalStore(subscribe, readPreference, serverPreference);
  const [still, setStill] = useState<string | null>(stillSrc ?? null);

  useEffect(() => {
    if (!reduce || still !== null) return;
    let live = true;
    restingFrame(src)
      .then((url) => {
        if (live) setStill(url);
      })
      .catch(() => {
        /* keeps the wrapper hidden; see the note above */
      });
    return () => {
      live = false;
    };
  }, [reduce, still, src]);

  const frozen = reduce && still !== null;

  return (
    <span className={frozen ? "block" : "block motion-reduce:hidden"}>
      {/* eslint-disable-next-line @next/next/no-img-element -- the signature must render with
          the markup mail clients receive: a plain <img> with an absolute URL and inline styles.
          next/image emits a srcset and a wrapper that no mail client understands. */}
      <img
        src={frozen && still !== null ? still : src}
        width={width}
        height={height}
        alt={alt}
        style={{ display: "block", border: 0, outline: "none" }}
      />
    </span>
  );
}
