import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Signature Studio — animated e-mail signatures, made in your browser",
  description:
    "Turn a photo into an animated black-and-white e-mail signature for Gmail or Outlook. No account, and your photo never leaves your device.",
};

/**
 * The canvas renderer needs the real font family string, not the CSS variable: next/font
 * mangles the family name at build time, so `ctx.font = "600 30px Geist Mono"` silently falls
 * back to a default and the wordmark comes out in the wrong typeface. Exported here so the
 * studio can pass the actual name through to the worker.
 */
export const MONO_FAMILY = geistMono.style.fontFamily;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
