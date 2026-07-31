/**
 * The markup generator — the last hundred metres of the product.
 *
 * Everything upstream of this file is image processing. This file is the part a mail client
 * actually receives, and mail clients are not browsers: they are a 1997 HTML renderer (Gmail),
 * Microsoft Word (classic Outlook on Windows), and WebKit with the rules changed (Apple Mail).
 * The rules below are not stylistic preferences, they are the intersection of what those three
 * agree on.
 *
 * TABLES AND INLINE STYLES, NOTHING ELSE. Gmail deletes `<style>` blocks outright, which takes
 * every class-based rule with it; Word has no flexbox and no grid; nobody honours a media
 * query in a signature. A layout expressed in anything but nested tables with inline styles
 * has already failed for a third of recipients before it is sent.
 *
 * ABSOLUTE URLS, NEVER BASE64. Gmail's signature field caps out near 10 000 characters and a
 * 70 KB GIF is ~93 000 characters of base64, so the images have to be hosted and linked. That
 * cap is also why `assertBudget` exists: Gmail truncates silently, so the first sign of an
 * over-long signature is a recipient seeing half a table. Better to refuse here, loudly.
 *
 * URL VALIDATION IS A SECURITY CONTROL, NOT TIDINESS. The user pastes this markup into their
 * own mail client with their own session. A `javascript:` href in a link the user typed is a
 * stored XSS that the victim installs by hand, and it ships to every recipient. Only http,
 * https and mailto survive; everything else is dropped rather than rendered inert, because a
 * dropped link is a visible absence the user can correct.
 */

import { NAME_W, NAME_H } from "./render";

export interface SignatureLink {
  label: string;
  url: string;
}

export interface SignatureData {
  name: string;
  title: string;
  organization?: string;
  email?: string;
  links: SignatureLink[];
  /** Absolute http(s) URL of the portrait GIF. */
  portraitUrl: string;
  /** Absolute http(s) URL of the wordmark GIF. Absent means the name ships as live text. */
  nameUrl?: string;
  /** DISPLAY size of the portrait, half the GIF's pixels. */
  portrait: { w: number; h: number };
  /**
   * DISPLAY size of the wordmark. Optional because the default — half of the renderer's
   * NAME_W × NAME_H — is right for a full-width wordmark; pass it when the wordmark GIF was
   * trimmed to a short name, since a stretched wordmark is worse than no wordmark.
   */
  nameSize?: { w: number; h: number };
}

/**
 * Gmail's signature field stops accepting input near this length. The number is not published
 * by Google and has moved before, so the ceiling we enforce sits below it.
 */
export const GMAIL_CHAR_CAP = 10_000;

/** What the builder will actually allow, leaving room for Gmail's own wrapper markup. */
export const MAX_SIGNATURE_CHARS = 9_000;

export class SignatureTooLongError extends Error {
  constructor(
    readonly count: number,
    readonly limit: number,
  ) {
    super(
      `Signature is ${count} characters, over the ${limit} character limit. ` +
        `Gmail truncates past ~${GMAIL_CHAR_CAP} without warning. Remove a link or shorten a field.`,
    );
    this.name = "SignatureTooLongError";
  }
}

/**
 * Counted in UTF-16 code units, which is what a textarea's maxlength counts and therefore the
 * closest available proxy for what Gmail measures. It over-counts astral characters (an emoji
 * counts two), and over-counting is the safe direction to be wrong in.
 */
export function signatureCharCount(html: string): number {
  return html.length;
}

/* ------------------------------------------------------------------------------------- */
/* Escaping and URL validation                                                            */
/* ------------------------------------------------------------------------------------- */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escapes for both text content and double-quoted attribute values. `'` is escaped too even
 * though our attributes are double-quoted, because names contain apostrophes constantly
 * (O'Brien, Côte-d'Or) and a raw one inside an attribute is a bug waiting for the day someone
 * switches a quote style.
 */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * Control characters and newlines are stripped rather than escaped: they carry no meaning in a
 * one-line field, and a stray newline pasted into Gmail's editor becomes a visible blank row.
 */
function clean(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Returns the normalised absolute URL, or null. `new URL` without a base rejects every
 * relative form for free, which is the "absolute" half of the requirement; the allowlist is
 * the security half. Note the check is on the PARSED protocol, so the classic bypasses
 * (`JaVaScRiPt:`, leading whitespace, embedded newlines) are all normalised away first.
 */
function safeUrl(raw: string, schemes: readonly string[]): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  return schemes.includes(u.protocol) ? u.href : null;
}

const LINK_SCHEMES = ["http:", "https:", "mailto:"] as const;
const IMAGE_SCHEMES = ["http:", "https:"] as const;

/**
 * The same markup, but rendered on THIS page rather than pasted into a mail client.
 *
 * The studio produces its GIFs in the browser and holds them as `blob:` object URLs, which the
 * deliverable must never contain — a blob URL is scoped to the tab that created it, so a
 * signature carrying one shows a broken image to every recipient, and to the sender too the
 * moment they reload. So `buildSignatureHtml` rejects them, correctly.
 *
 * But the on-screen preview has to show those very blobs, and it has to show them through the
 * SAME builder, or the thing being previewed is not the thing being shipped. Hence a second
 * allowlist used only by `{ preview: true }`, never on the copy path.
 */
const PREVIEW_IMAGE_SCHEMES = ["http:", "https:", "blob:", "data:"] as const;

/**
 * Deliberately loose. A signature is not an authentication boundary, so the job here is to
 * reject things that are not addresses at all — anything that could smuggle a scheme or break
 * out of the mailto: URL — not to adjudicate RFC 5322.
 */
const EMAIL_RE = /^[^\s@<>"'\\,;:/?#]+@[^\s@<>"'\\,;:/?#]+\.[^\s@<>"'\\,;:/?#]+$/;

/* ------------------------------------------------------------------------------------- */
/* Type                                                                                   */
/* ------------------------------------------------------------------------------------- */

/**
 * Web fonts never load in mail — Gmail strips @font-face, Outlook never had it — so the stack
 * has to look deliberate on its fallback alone. Arial is last-but-one because it is the only
 * name here present on every Windows install, and Word picks the first family it can resolve.
 */
const SANS = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";

/**
 * Used only when the name ships as live text, to echo the wordmark's monospace face. Courier
 * New is the floor and exists everywhere.
 */
const MONO = "'SF Mono',SFMono-Regular,Menlo,Consolas,'Courier New',monospace";

const INK = "#0a0a0a";
const INK_2 = "#262626";
const INK_3 = "#404040";
const MUTE = "#737373";
const MUTE_2 = "#a3a3a3";

/* ------------------------------------------------------------------------------------- */
/* Builder                                                                                */
/* ------------------------------------------------------------------------------------- */

function px(n: number, what: string): number {
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${what} must be a positive number, got ${String(n)}`);
  }
  // Mail clients want integers in width/height attributes; a fractional one is dropped by
  // Word, which then renders the image at its native size — twice as large as intended.
  return Math.round(n);
}

function img(src: string, w: number, h: number, alt: string): string {
  // display:block kills the baseline gap under the image; the explicit width/height attributes
  // are for Word, which ignores the CSS ones. -ms-interpolation-mode is the only lever Outlook
  // gives over downscaling quality, and every image here is downscaled 2×.
  return (
    `<img src="${esc(src)}" width="${w}" height="${h}" alt="${esc(alt)}" ` +
    `style="display:block;width:${w}px;height:${h}px;border:0;outline:none;` +
    `text-decoration:none;-ms-interpolation-mode:bicubic;" />`
  );
}

function row(padTop: number, style: string, content: string): string {
  const pad = padTop === 0 ? "padding:0;" : `padding:${padTop}px 0 0 0;`;
  return `<tr><td style="${pad}${style}">${content}</td></tr>`;
}

export interface BuildOptions {
  /**
   * Render for the on-screen preview, which permits `blob:` and `data:` image URLs. NEVER set
   * this on the copy path: those URLs are meaningless outside the tab that made them.
   */
  preview?: boolean;
}

export function buildSignatureHtml(d: SignatureData, opts: BuildOptions = {}): string {
  const imageSchemes = opts.preview ? PREVIEW_IMAGE_SCHEMES : IMAGE_SCHEMES;
  const name = clean(d.name);
  if (name.length === 0) throw new Error("name is required");
  const title = clean(d.title);
  const organization = d.organization ? clean(d.organization) : "";

  const portraitSrc = safeUrl(d.portraitUrl, imageSchemes);
  if (portraitSrc === null) {
    // Unlike a user-typed link, this URL comes from our own upload step. A bad one is a bug in
    // the pipeline, and a signature with no portrait is not a degraded signature, it is a
    // different product.
    throw new Error(
      "portraitUrl must be an absolute http(s) URL — mail clients cannot resolve a relative one",
    );
  }
  const pw = px(d.portrait.w, "portrait.w");
  const ph = px(d.portrait.h, "portrait.h");

  // A wordmark that fails validation degrades to live text rather than throwing: the name is
  // recoverable in a way the portrait is not.
  const nameSrc = d.nameUrl ? safeUrl(d.nameUrl, imageSchemes) : null;

  const rows: string[] = [];

  if (nameSrc !== null) {
    const nw = px(d.nameSize?.w ?? NAME_W / 2, "nameSize.w");
    const nh = px(d.nameSize?.h ?? NAME_H / 2, "nameSize.h");
    // The alt IS the name. With images blocked this line is the entire identity of the
    // signature, so it may not be decorative text and it may not be empty.
    rows.push(row(0, "line-height:0;", img(nameSrc, nw, nh, name)));
  } else {
    rows.push(
      row(
        0,
        `font-family:${MONO};font-size:17px;font-weight:600;letter-spacing:-0.2px;` +
          `line-height:22px;color:${INK};white-space:nowrap;`,
        esc(name),
      ),
    );
  }

  if (title.length > 0) {
    rows.push(
      row(nameSrc !== null ? 10 : 8, `font-size:13px;line-height:18px;color:${INK_2};`, esc(title)),
    );
  }
  if (organization.length > 0) {
    rows.push(row(2, `font-size:13px;line-height:18px;color:${MUTE};`, esc(organization)));
  }

  const email = d.email ? clean(d.email) : "";
  if (email.length > 0 && EMAIL_RE.test(email)) {
    const href = safeUrl(`mailto:${email}`, LINK_SCHEMES);
    if (href !== null) {
      rows.push(
        row(
          10,
          "font-size:13px;line-height:18px;",
          `<a href="${esc(href)}" style="color:${INK};text-decoration:underline;">${esc(email)}</a>`,
        ),
      );
    }
  }

  const links = d.links
    .map((l) => ({ label: clean(l.label), url: safeUrl(l.url, LINK_SCHEMES) }))
    .filter((l): l is { label: string; url: string } => l.url !== null && l.label.length > 0)
    .map(
      (l) =>
        `<a href="${esc(l.url)}" style="color:${INK_3};text-decoration:underline;">${esc(l.label)}</a>`,
    );

  if (links.length > 0) {
    const sep = `<span style="color:${MUTE_2};">&#160;&#183;&#160;</span>`;
    rows.push(row(6, "font-size:12px;line-height:16px;", links.join(sep)));
  }

  // Two nested tables rather than divs: Word's box model drops margins on a div and collapses
  // padding unpredictably, but it has always got table cell padding right.
  const html =
    `<table border="0" cellpadding="0" cellspacing="0" role="presentation" ` +
    `style="border-collapse:collapse;border-spacing:0;font-family:${SANS};color:${INK};">` +
    `<tr>` +
    `<td width="${pw}" style="padding:0 16px 0 0;vertical-align:top;">` +
    img(portraitSrc, pw, ph, name) +
    `</td>` +
    `<td style="padding:0;vertical-align:top;">` +
    `<table border="0" cellpadding="0" cellspacing="0" role="presentation" ` +
    `style="border-collapse:collapse;border-spacing:0;font-family:${SANS};">` +
    rows.join("") +
    `</table>` +
    `</td>` +
    `</tr>` +
    `</table>`;

  const count = signatureCharCount(html);
  if (count > MAX_SIGNATURE_CHARS) throw new SignatureTooLongError(count, MAX_SIGNATURE_CHARS);

  return html;
}

/**
 * The text/plain flavour written alongside the HTML on the clipboard. A rich-text field takes
 * text/html and ignores this; a plain-text one takes this and would otherwise receive the
 * markup as literal visible source.
 */
export function buildSignatureText(d: SignatureData): string {
  const lines: string[] = [];
  const push = (s: string) => {
    if (s.length > 0) lines.push(s);
  };

  push(clean(d.name));
  push(clean(d.title));
  push(d.organization ? clean(d.organization) : "");

  const email = d.email ? clean(d.email) : "";
  if (email.length > 0 && EMAIL_RE.test(email)) push(email);

  for (const l of d.links) {
    const url = safeUrl(l.url, LINK_SCHEMES);
    const label = clean(l.label);
    if (url !== null && label.length > 0) push(`${label}: ${url}`);
  }

  return lines.join("\n");
}
