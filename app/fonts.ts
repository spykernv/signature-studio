import { Geist, Geist_Mono } from "next/font/google";

export const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
export const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

/**
 * The real family name, for canvas.
 *
 * next/font mangles the family at build time, so `ctx.font = "600 30px Geist Mono"` matches
 * nothing and silently falls back to a default — the wordmark would come out in the wrong
 * typeface with no error anywhere.
 *
 * It lives here rather than in layout.tsx because the studio is a client component: importing
 * it from the layout drags `metadata` into the client bundle, which Next refuses outright.
 */
export const MONO_FAMILY = geistMono.style.fontFamily;
