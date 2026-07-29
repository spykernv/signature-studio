import Link from "next/link";

import {
  DEMO_PORTRAIT_SRC,
  DEMO_SIGNATURE,
  SignaturePreview,
} from "./signature-preview";

/**
 * The result comes first, moving, before a single word of copy. Everything the page claims is
 * visible in the top 400px, and the block below the heading is not a mockup of the output —
 * it is the output markup, rendered live.
 */
export function Hero() {
  return (
    <section className="pt-14 sm:pt-20">
      <div className="inline-block border border-line bg-white px-7 py-8 sm:px-10 sm:py-10">
        <SignaturePreview
          fields={DEMO_SIGNATURE}
          portraitSrc={DEMO_PORTRAIT_SRC}
          portraitAlt="An animated signature portrait: the photograph is cut into five leaning bands that scatter and settle back into place."
        />
      </div>

      <h1 className="mt-12 max-w-[26ch] text-2xl leading-snug font-medium tracking-tight text-balance text-ink sm:text-3xl">
        Turn a photo into an animated signature you can paste into Gmail or Outlook.
      </h1>

      <p className="mt-4 max-w-[46ch] text-[15px] leading-relaxed text-ink-3">
        No account, nothing to install, and about two minutes of your time.
      </p>

      <p className="mt-8">
        <Link
          href="/studio"
          // Two rings, because this control is black on white: the outline alone would be a
          // black line 2px off a black button, and the inset white one is what makes the focus
          // state unmistakable against the dark fill.
          className="mono inline-flex h-12 items-center bg-ink px-7 text-[13px] tracking-[0.12em] text-white uppercase transition-colors hover:bg-ink-2 focus-visible:inset-ring-2 focus-visible:inset-ring-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          Make yours
        </Link>
      </p>
    </section>
  );
}
