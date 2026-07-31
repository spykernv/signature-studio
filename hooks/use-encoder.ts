"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Crop, BandGeometry } from "@/lib/geometry";
import type { RenderPhase, StudioRequest, StudioResponse } from "@/workers/encode.worker";

export interface RenderProgress {
  phase: RenderPhase;
  done: number;
  total: number;
}

export interface RenderResult {
  portrait: Uint8Array;
  wordmark: Uint8Array | null;
}

/**
 * Owns the encode worker for the length of a session.
 *
 * The worker is created once and the source photograph is posted to it once, because the whole
 * point of step 2 is that a drag re-renders a preview immediately — re-sending a 3 MB ImageData
 * on every pointer move would make the positioner feel broken on exactly the screen that has to
 * feel precise.
 */
export function useEncoder() {
  const workerRef = useRef<Worker | null>(null);
  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState<RenderProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Only the newest preview matters. A drag can outrun the encoder, and painting a stale frame
  // makes the guides look like they are lagging behind the pointer when they are not.
  const previewId = useRef(0);
  const onPreview = useRef<((b: ImageBitmap, id: number) => void) | null>(null);
  const onDone = useRef<((r: RenderResult) => void) | null>(null);

  useEffect(() => {
    const w = new Worker(new URL("../workers/encode.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = w;

    w.onmessage = (ev: MessageEvent<StudioResponse>) => {
      const msg = ev.data;
      if (msg.type === "preview") {
        if (msg.id === previewId.current) onPreview.current?.(msg.bitmap, msg.id);
        else msg.bitmap.close(); // a superseded frame; releasing it is not optional at 110/s
      } else if (msg.type === "progress") {
        setProgress({ phase: msg.phase, done: msg.done, total: msg.total });
      } else if (msg.type === "done") {
        setProgress(null);
        onDone.current?.({ portrait: msg.portrait, wordmark: msg.wordmark });
      } else if (msg.type === "error") {
        // A failed preview is a shrug — the next drag replaces it. A failed render is the end
        // of the road and has to reach the user.
        if (msg.fatal) {
          setError(msg.message);
          setProgress(null);
        }
      }
    };

    return () => {
      w.onmessage = null;
      w.terminate();
      workerRef.current = null;
    };
  }, []);

  const post = (msg: StudioRequest) => workerRef.current?.postMessage(msg);

  const setSource = useCallback((source: ImageData) => {
    setReady(false);
    setError(null);
    // NOT transferred. The page keeps this ImageData to redraw the positioner, and transferring
    // it would detach the buffer out from under the very canvas the user is dragging on.
    workerRef.current?.postMessage({ type: "source", source } satisfies StudioRequest);
    setReady(true);
  }, []);

  const requestPreview = useCallback(
    (crop: Crop, geom: BandGeometry, cb: (b: ImageBitmap) => void) => {
      const id = ++previewId.current;
      onPreview.current = (b, gotId) => {
        if (gotId === previewId.current) cb(b);
      };
      post({ type: "preview", id, crop, geom });
    },
    [],
  );

  const render = useCallback(
    (crop: Crop, geom: BandGeometry, nameFrames: ImageData[] | null) =>
      new Promise<RenderResult>((resolve, reject) => {
        onDone.current = resolve;
        setError(null);
        const stop = setTimeout(
          () => reject(new Error("the encoder did not answer within 60 seconds")),
          60_000,
        );
        onDone.current = (r) => {
          clearTimeout(stop);
          resolve(r);
        };
        post({ type: "render", crop, geom, nameFrames });
      }),
    [],
  );

  return { ready, progress, error, setSource, requestPreview, render };
}
