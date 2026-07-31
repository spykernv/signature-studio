"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { solve, type Landmarks } from "@/lib/geometry";
import { nameFitsGrid, MAX_NAME_CHARS, NAME_W, NAME_H } from "@/lib/render";
import { CANVAS_W, CANVAS_H } from "@/lib/geometry";
import { loadPhoto, PhotoError, formatBytes, type Photo } from "@/hooks/decode-photo";
import { renderNameFrames } from "@/hooks/name-frames";
import { useEncoder } from "@/hooks/use-encoder";
import { detect } from "@/lib/landmarks";
import PlaceFace from "@/components/studio/PlaceFace";
import CopySignature from "@/components/CopySignature";
import PasteSteps from "@/components/PasteSteps";
import { buildSignatureHtml, signatureCharCount, type SignatureData } from "@/lib/signature-html";
import { MONO_FAMILY } from "@/app/fonts";

const STEPS = ["Photo", "Face", "Details", "Signature"] as const;

/** Sensible starting guides when no face was found: a head-and-shoulders portrait, roughly. */
const DEFAULT_LANDMARKS: Landmarks = { faceCx: 0.5, browY: 0.32, chinY: 0.46 };

interface Details {
  name: string;
  title: string;
  organization: string;
  email: string;
  links: { label: string; url: string }[];
}

export default function StudioPage() {
  const [step, setStep] = useState(0);
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [photoError, setPhotoError] = useState<{ kind: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [landmarks, setLandmarks] = useState<Landmarks>(DEFAULT_LANDMARKS);
  const [autoPlaced, setAutoPlaced] = useState(false);
  const [details, setDetails] = useState<Details>({
    name: "",
    title: "",
    organization: "",
    email: "",
    links: [],
  });
  const [result, setResult] = useState<{
    /** Object URLs, for the on-screen preview only — see the `preview` flag on the builder. */
    portrait: string;
    wordmark: string | null;
    bytes: number;
    /** The raw files, kept because publishing has to re-send them. */
    portraitData: Uint8Array;
    wordmarkData: Uint8Array | null;
  } | null>(null);

  const encoder = useEncoder();

  // Phones can complete every step here and then hit a wall: neither the Gmail nor the Outlook
  // mobile signature editor accepts anything but plain text. Saying so before the upload button
  // costs one line; saying it afterwards wastes somebody's five minutes.
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    setCoarse(window.matchMedia("(pointer: coarse)").matches);
  }, []);

  const solution = useMemo(
    () => (photo ? solve({ w: photo.width, h: photo.height }, landmarks) : null),
    [photo, landmarks],
  );

  /* ---------------------------------------------------------------- step 1 : photo ------ */

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setPhotoError(null);
    setBusy(true);
    try {
      const p = await loadPhoto(file);
      setPhoto(p);
      encoder.setSource(p.work);

      const found = await detect(p.bitmap);
      if (found.landmarks) {
        setLandmarks(found.landmarks);
        setAutoPlaced(true);
      } else {
        setLandmarks(DEFAULT_LANDMARKS);
        setAutoPlaced(false);
      }
      setStep(1);
    } catch (err) {
      const kind = err instanceof PhotoError ? err.kind : "undecodable";
      setPhotoError({ kind, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  /* ---------------------------------------------------------------- step 2 : preview ---- */

  const paint = useRef<number>(0);
  useEffect(() => {
    if (step !== 1 || !solution || !photo) return;
    const token = ++paint.current;
    encoder.requestPreview(solution.crop, solution.geom, (bitmap) => {
      if (token !== paint.current) {
        bitmap.close();
        return;
      }
      const canvas = document.getElementById("studio-preview") as HTMLCanvasElement | null;
      canvas?.getContext("2d")?.drawImage(bitmap, 0, 0);
      bitmap.close();
    });
  }, [step, solution, photo, encoder]);

  /* ---------------------------------------------------------------- step 4 : render ----- */

  const animatedName = nameFitsGrid(details.name);

  const run = async () => {
    if (!solution || !photo) return;
    setBusy(true);
    try {
      const frames = animatedName ? await renderNameFrames(details.name, MONO_FAMILY) : null;
      const out = await encoder.render(solution.crop, solution.geom, frames);
      const url = (b: Uint8Array) =>
        URL.createObjectURL(new Blob([new Uint8Array(b)], { type: "image/gif" }));
      setResult({
        portrait: url(out.portrait),
        wordmark: out.wordmark ? url(out.wordmark) : null,
        bytes: out.portrait.byteLength + (out.wordmark?.byteLength ?? 0),
        portraitData: out.portrait,
        wordmarkData: out.wordmark,
      });
      setPublished(null);
      setPublishError(null);
      setStep(3);
    } finally {
      setBusy(false);
    }
  };

  // The public addresses, once the GIFs have been uploaded. A signature carrying a blob: URL is
  // broken for every recipient AND for the sender on their next reload, so nothing may be
  // copied until these exist.
  const [published, setPublished] = useState<{ portraitUrl: string; wordmarkUrl: string | null } | null>(
    null,
  );
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);

  const publish = async () => {
    if (!result) return null;
    setPublishing(true);
    setPublishError(null);
    try {
      const body = new FormData();
      body.append("portrait", new Blob([new Uint8Array(result.portraitData)], { type: "image/gif" }));
      if (result.wordmarkData) {
        body.append("wordmark", new Blob([new Uint8Array(result.wordmarkData)], { type: "image/gif" }));
      }
      const res = await fetch("/api/publish", { method: "POST", body });
      const json = (await res.json()) as
        | { portraitUrl: string; wordmarkUrl: string | null }
        | { error: string };
      if (!res.ok || "error" in json) {
        setPublishError("error" in json ? json.error : "Could not publish.");
        return null;
      }
      setPublished(json);
      return json;
    } catch {
      setPublishError("Could not reach the server. Your download still works.");
      return null;
    } finally {
      setPublishing(false);
    }
  };

  const signature: SignatureData | null = result
    ? {
        name: details.name,
        title: details.title,
        organization: details.organization || undefined,
        email: details.email || undefined,
        links: details.links.filter((l) => l.label && l.url),
        portraitUrl: result.portrait,
        nameUrl: result.wordmark ?? undefined,
        portrait: { w: CANVAS_W / 2, h: CANVAS_H / 2 },
        nameSize: { w: NAME_W / 2, h: NAME_H / 2 },
      }
    : null;

  return (
    <main className="mx-auto max-w-4xl px-6 py-14">
      <header className="flex items-baseline justify-between">
        <Link href="/" className="stamp hover:text-ink">
          ← Signature Studio
        </Link>
        <ol className="flex gap-5" aria-label="Progress">
          {STEPS.map((label, i) => (
            <li
              key={label}
              aria-current={i === step ? "step" : undefined}
              className={`stamp ${i === step ? "text-ink" : i < step ? "text-mute-2" : "text-line-2"}`}
            >
              {i + 1} {label}
            </li>
          ))}
        </ol>
      </header>

      <div className="mt-12">
        {/* ------------------------------------------------------------- 1 ---------------- */}
        {step === 0 && (
          <section>
            <h1 className="text-2xl tracking-tight">Start with a photo</h1>
            <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-mute">
              Head and shoulders, with a little room above your head. It is turned black and
              white and cropped square-ish. It never leaves this device — only the finished
              animation does, and only if you choose to publish it.
            </p>

            {coarse && (
              <p className="mt-6 max-w-xl border-l-2 border-ink pl-3 text-[13px] leading-relaxed">
                You can do all of this on your phone, but you will need a computer for the last
                step: the Gmail and Outlook phone apps only accept plain-text signatures.
              </p>
            )}

            <label
              className="mt-8 flex cursor-pointer flex-col items-center justify-center border border-dashed border-line-2 px-8 py-16 text-center transition hover:border-ink focus-within:ring-2 focus-within:ring-ink"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void onFile(e.dataTransfer.files[0]);
              }}
            >
              <span className="text-[15px]">
                {busy ? "Reading…" : "Drop a photo, or choose a file"}
              </span>
              <span className="stamp mt-2">JPEG or PNG · up to 25 MB</span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                onChange={(e) => void onFile(e.target.files?.[0])}
              />
            </label>

            {photoError && (
              <p className="mt-5 border-l-2 border-ink pl-3 text-[13px] leading-relaxed">
                {photoError.kind === "heic"
                  ? "iPhone photos in HEIC cannot be read by browsers. Take a screenshot of it, or export it as JPEG, and try again."
                  : photoError.kind === "too-big"
                    ? "That file is over 25 MB. A smaller export of the same photo will do."
                    : photoError.message}
              </p>
            )}
          </section>
        )}

        {/* ------------------------------------------------------------- 2 ---------------- */}
        {step === 1 && photo && solution && (
          <section>
            <h1 className="text-2xl tracking-tight">Where is your face?</h1>
            <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-mute">
              Two lines is all it takes. Everything about the animation — how deep the steps are,
              where it crops — is worked out from them.
            </p>
            <div className="mt-8">
              <PlaceFace
                photo={photo.bitmap}
                width={photo.width}
                height={photo.height}
                landmarks={landmarks}
                onChange={setLandmarks}
                solution={solution}
                autoPlaced={autoPlaced}
              />
            </div>
            <Nav
              onBack={() => setStep(0)}
              onNext={() => setStep(2)}
              nextLabel="Details"
              disabled={!solution.ok}
            />
          </section>
        )}

        {/* ------------------------------------------------------------- 3 ---------------- */}
        {step === 2 && (
          <section>
            <h1 className="text-2xl tracking-tight">Your details</h1>
            <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-mute">
              Everything except your name stays as real text in the signature, so it is readable
              even when a recipient blocks images.
            </p>

            <div className="mt-8 grid gap-8 md:grid-cols-2">
              <div className="space-y-5">
                <Field label="Name" value={details.name} onChange={(v) => setDetails({ ...details, name: v })} />
                <Field label="Title" value={details.title} onChange={(v) => setDetails({ ...details, title: v })} />
                <Field
                  label="Organisation"
                  value={details.organization}
                  onChange={(v) => setDetails({ ...details, organization: v })}
                />
                <Field
                  label="Email"
                  type="email"
                  value={details.email}
                  onChange={(v) => setDetails({ ...details, email: v })}
                />

                <p className="text-[13px] leading-relaxed text-mute">
                  {details.name.length === 0 ? (
                    "Your name is typed out letter by letter in the animation."
                  ) : animatedName ? (
                    <>Your name is short enough to be typed out in the animation.</>
                  ) : (
                    <>
                      Your name ships as ordinary text rather than animated — the typed effect
                      uses a fixed grid that holds {MAX_NAME_CHARS} Latin characters. It looks
                      the same at rest, and it stays selectable.
                    </>
                  )}
                </p>
              </div>

              <div>
                <p className="stamp">Preview</p>
                <div className="mt-3 border border-line bg-white p-5">
                  <canvas id="studio-preview" width={224} height={276} className="block" />
                  <p className="mt-3 text-[15px]">{details.name || "Your name"}</p>
                  <p className="text-[13px] text-ink-3">{details.title || "Your title"}</p>
                </div>
              </div>
            </div>

            <Nav
              onBack={() => setStep(1)}
              onNext={() => void run()}
              nextLabel={busy ? "Rendering…" : "Make the signature"}
              disabled={busy || details.name.trim().length === 0}
            />
            {encoder.progress && (
              <p className="mt-4 stamp">
                {encoder.progress.phase} {encoder.progress.done}/{encoder.progress.total}
              </p>
            )}
          </section>
        )}

        {/* ------------------------------------------------------------- 4 ---------------- */}
        {step === 3 && result && signature && (
          <section>
            <h1 className="text-2xl tracking-tight">Your signature</h1>
            <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-mute">
              {formatBytes(result.bytes)} in total. Copy it, then follow the steps for your mail
              client below.
            </p>

            <div className="mt-8 border border-line bg-white p-8">
              <div
                dangerouslySetInnerHTML={{
                  __html: buildSignatureHtml(signature, { preview: true }),
                }}
                aria-label="Your signature"
              />
            </div>

            <p className="stamp mt-3">
              {signatureCharCount(buildSignatureHtml(signature, { preview: true }))} characters ·
              Gmail allows 10 000
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-4">
              <a
                href={result.portrait}
                download="signature-portrait.gif"
                className="bg-ink px-5 py-2.5 text-[13px] text-white"
              >
                Download the portrait
              </a>
              {result.wordmark && (
                <a
                  href={result.wordmark}
                  download="signature-name.gif"
                  className="border border-line px-4 py-2.5 text-[13px] hover:border-ink"
                >
                  Download the name
                </a>
              )}
              <button
                type="button"
                onClick={() => setStep(2)}
                className="text-[13px] text-mute underline underline-offset-4 hover:text-ink"
              >
                Change the details
              </button>
            </div>

            {published === null ? (
              <div className="mt-10">
                <button
                  type="button"
                  onClick={() => void publish()}
                  disabled={publishing}
                  className="bg-ink px-5 py-2.5 text-[13px] text-white disabled:bg-line-2 disabled:text-mute"
                >
                  {publishing ? "Publishing…" : "Publish, then copy"}
                </button>
                <p className="mt-4 max-w-xl text-[13px] leading-relaxed text-mute">
                  A mail signature can only link to images, it cannot carry them — so the two
                  small GIFs above go online at a permanent address, and the signature points at
                  them. That address is public and unguessable. Nothing else about you is
                  uploaded, and your original photo never left this device.
                </p>
                {publishError && (
                  <p className="mt-4 max-w-xl border-l-2 border-ink pl-3 text-[13px] leading-relaxed">
                    {publishError}
                  </p>
                )}
              </div>
            ) : (
              <div className="mt-10">
                {/* Publishing and copying are two clicks on purpose. The clipboard write has to
                    happen inside the click that triggers it — Safari discards a write whose
                    promise settles after the gesture ends — and an upload cannot fit inside
                    that window. Splitting them also makes the upload a decision rather than a
                    side effect of arriving on this screen. */}
                <CopySignature
                  data={{
                    ...signature,
                    portraitUrl: published.portraitUrl,
                    nameUrl: published.wordmarkUrl ?? undefined,
                  }}
                />
                <p className="mt-4 max-w-xl text-[13px] leading-relaxed text-mute">
                  Published. Keep this address if you ever want to point at it again — editing
                  your photo later produces a new one, because Gmail caches images at a URL and
                  never expires them.
                </p>
                <p className="mono mt-3 max-w-xl break-all text-[11px] text-mute-2">
                  {published.portraitUrl}
                </p>
              </div>
            )}

            <div className="mt-14">
              <PasteSteps />
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

function Nav({
  onBack,
  onNext,
  nextLabel,
  disabled,
}: {
  onBack: () => void;
  onNext: () => void;
  nextLabel: string;
  disabled?: boolean;
}) {
  return (
    <div className="mt-12 flex items-center gap-5">
      <button
        type="button"
        onClick={onBack}
        className="text-[13px] text-mute underline underline-offset-4 hover:text-ink"
      >
        Back
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={disabled}
        className="bg-ink px-5 py-2.5 text-[13px] text-white disabled:bg-line-2 disabled:text-mute"
      >
        {nextLabel}
      </button>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="stamp">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-2 w-full border-b border-line bg-transparent pb-2 text-[15px] outline-none focus:border-ink"
      />
    </label>
  );
}
