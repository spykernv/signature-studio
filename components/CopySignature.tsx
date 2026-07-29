"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildSignatureHtml,
  buildSignatureText,
  signatureCharCount,
  MAX_SIGNATURE_CHARS,
  type SignatureData,
} from "@/lib/signature-html";

/**
 * The copy button.
 *
 * TWO FLAVOURS, NOT ONE. Gmail's and Outlook's signature boxes are rich-text fields, so
 * `writeText` pastes the markup as visible source — the single most common way a tool like
 * this fails. The clipboard has to carry `text/html` for the rich field and `text/plain` as
 * the fallback flavour any plain field will take instead.
 *
 * THE MARKUP IS BUILT DURING RENDER, NOT ON CLICK. Safari treats the clipboard write as part
 * of the user gesture and revokes permission if the promise passed to it settles from work
 * started outside that gesture. Building eagerly in a memo means the handler does nothing but
 * wrap two strings in Blobs — synchronous, and still inside the gesture.
 *
 * THE HIDDEN NODE IS NOT DEAD CODE. `ClipboardItem` is missing in older Firefox and Safari,
 * and the whole async Clipboard API is unavailable outside a secure context — which includes
 * anyone testing this over plain http on a LAN address. The selection + execCommand path is
 * deprecated and still the only thing that works there.
 */

export interface CopySignatureProps {
  data: SignatureData;
  /** Fires only on a confirmed copy — the caller can use it to reveal the paste steps. */
  onCopied?: () => void;
}

type State = "idle" | "copied" | "failed";

/**
 * The legacy path. It needs a node that is actually laid out — `display:none` has no
 * selectable content — hence the off-screen position rather than hiding it.
 */
function copyBySelection(node: HTMLElement | null): boolean {
  if (node === null || typeof window === "undefined") return false;
  const selection = window.getSelection();
  if (selection === null) return false;

  const previous = selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);

  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }

  selection.removeAllRanges();
  if (previous !== null) selection.addRange(previous);
  return ok;
}

export default function CopySignature({ data, onCopied }: CopySignatureProps) {
  const [state, setState] = useState<State>("idle");
  const hiddenRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const built = useMemo(() => {
    try {
      return { html: buildSignatureHtml(data), text: buildSignatureText(data), error: null };
    } catch (e) {
      return { html: null, text: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [data]);

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const flash = useCallback((next: State) => {
    setState(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 4000);
  }, []);

  const copy = useCallback(async () => {
    const { html, text } = built;
    if (html === null || text === null) return;

    const rich =
      typeof ClipboardItem !== "undefined" &&
      typeof navigator !== "undefined" &&
      navigator.clipboard !== undefined &&
      window.isSecureContext;

    if (rich) {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([text], { type: "text/plain" }),
          }),
        ]);
        flash("copied");
        onCopied?.();
        return;
      } catch {
        // Permission denied, or a browser that advertises the API and refuses the write.
        // Fall through rather than reporting a failure the legacy path can still avoid.
      }
    }

    if (copyBySelection(hiddenRef.current)) {
      flash("copied");
      onCopied?.();
      return;
    }
    flash("failed");
  }, [built, flash, onCopied]);

  if (built.error !== null) {
    return (
      <div className="border border-line-2 p-6">
        <p className="stamp">Cannot build</p>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-2">{built.error}</p>
      </div>
    );
  }

  const count = signatureCharCount(built.html ?? "");
  const tight = count > MAX_SIGNATURE_CHARS * 0.9;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={copy}
          className="border border-ink bg-ink px-6 py-3 text-sm text-white transition-colors hover:bg-ink-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          Copy signature
        </button>

        {/* aria-live so the confirmation reaches a screen reader; the button label never
            changes, because a button that renames itself loses its accessible name mid-press. */}
        <p aria-live="polite" className="text-sm text-ink-2">
          {state === "copied" ? "Copied. Now paste it into your mail client." : null}
          {state === "failed"
            ? "Your browser blocked the copy. Select the preview above and copy it by hand."
            : null}
        </p>
      </div>

      <p className="stamp mt-4">
        <span className="mono">{count.toLocaleString("en-US")}</span> of{" "}
        <span className="mono">{MAX_SIGNATURE_CHARS.toLocaleString("en-US")}</span> characters
      </p>
      {tight ? (
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-mute">
          Close to the limit Gmail enforces. Adding another link may push it over, and Gmail cuts
          a long signature without saying so.
        </p>
      ) : null}

      {/*
        The exact markup, off-screen, for the execCommand fallback. dangerouslySetInnerHTML is
        the point of the node rather than a shortcut: the fallback copies a DOM selection, so
        the HTML has to be real DOM. It is our own string — every user field escaped, every URL
        scheme allowlisted — so there is nothing here React would have protected us from.
      */}
      <div
        ref={hiddenRef}
        aria-hidden="true"
        style={{ position: "fixed", top: 0, left: "-10000px", width: "1px", overflow: "hidden" }}
        dangerouslySetInnerHTML={{ __html: built.html ?? "" }}
      />
    </div>
  );
}
