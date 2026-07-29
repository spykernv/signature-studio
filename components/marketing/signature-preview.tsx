import { RestingFrameImage } from "./resting-frame-image";

/**
 * The signature, rendered the way a mail client renders it: one table, inline styles, no
 * classes. This is deliberately not "a nice web version of the signature" — it is the output,
 * so the landing page cannot promise something the export does not deliver.
 *
 * The portrait is the only image. Everything to the left of it is live text, which is what
 * keeps the whole thing under Gmail's ~10 000 character signature cap and what makes the
 * signature legible when a client blocks remote images.
 */

/** 224 x 276 is the encoder's output; it is placed at half size so it stays sharp on a
 *  2x screen, which is what every retina mail client is. */
const PORTRAIT_W = 112;
const PORTRAIT_H = 138;

/**
 * The exported signature needs an ABSOLUTE url — a mail client has no origin to resolve a
 * relative path against. In development the reference GIF is served by the fixture route, so
 * the swap seam is an env var rather than an edit.
 */
export const DEMO_PORTRAIT_SRC =
  process.env.NEXT_PUBLIC_DEMO_PORTRAIT_URL ?? "/api/fixture/reference-sig-a.gif";

/**
 * The site's own fonts come from next/font, which mangles the family name at build time, so
 * the CSS variable has to lead. The literal names behind it are the ones a recipient's client
 * resolves, and the generic at the end is what almost all of them actually land on.
 */
const MONO =
  "var(--font-geist-mono), 'Geist Mono', 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace";
const SANS =
  "var(--font-geist-sans), 'Geist', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

export interface SignatureFields {
  name: string;
  role: string;
  email: string;
  link: { label: string; href: string };
}

export const DEMO_SIGNATURE: SignatureFields = {
  name: "Jonathan Naal",
  role: "Product Manager & Business Analyst",
  email: "jonathannaal.official@gmail.com",
  link: {
    label: "linkedin.com/in/jonathannaal",
    href: "https://www.linkedin.com/in/jonathannaal/",
  },
};

export interface SignaturePreviewProps {
  fields: SignatureFields;
  portraitSrc: string;
  /** Overrides the client-side freeze used for prefers-reduced-motion. */
  portraitStillSrc?: string;
  /** Describes the animation to a screen reader here; the export uses the person's name. */
  portraitAlt: string;
}

export function SignaturePreview({
  fields,
  portraitSrc,
  portraitStillSrc,
  portraitAlt,
}: SignaturePreviewProps) {
  return (
    <table cellPadding={0} cellSpacing={0} border={0} style={{ borderCollapse: "collapse" }}>
      <tbody>
        <tr>
          <td style={{ padding: "0 22px 0 0", verticalAlign: "top" }}>
            <div
              style={{
                fontFamily: MONO,
                // 15px / 600 / 0.166em is the wordmark of the reference render at its placed
                // size: 30px on a 23px monospace grid, halved.
                fontSize: "15px",
                fontWeight: 600,
                letterSpacing: "0.166em",
                textTransform: "uppercase",
                color: "#0a0a0a",
                lineHeight: 1.3,
                whiteSpace: "nowrap",
              }}
            >
              {fields.name}
            </div>
            <div
              style={{
                fontFamily: SANS,
                fontSize: "13px",
                color: "#404040",
                lineHeight: 1.5,
                paddingTop: "4px",
                whiteSpace: "nowrap",
              }}
            >
              {fields.role}
            </div>
            {/* A div, not an <hr>: Outlook gives <hr> a 3D border it will not let go of. */}
            <div
              style={{
                width: "190px",
                height: "1px",
                backgroundColor: "#d4d4d4",
                margin: "11px 0",
                fontSize: 0,
                lineHeight: 0,
              }}
            >
              &nbsp;
            </div>
            <div style={{ fontFamily: MONO, fontSize: "12px", lineHeight: 1.7 }}>
              <a
                href={`mailto:${fields.email}`}
                style={{ color: "#0a0a0a", textDecoration: "none" }}
                className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                {fields.email}
              </a>
            </div>
            <div style={{ fontFamily: MONO, fontSize: "12px", lineHeight: 1.7 }}>
              <a
                href={fields.link.href}
                style={{ color: "#0a0a0a", textDecoration: "none" }}
                className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                {fields.link.label}
              </a>
            </div>
          </td>
          <td style={{ verticalAlign: "top", width: `${PORTRAIT_W}px` }}>
            <RestingFrameImage
              src={portraitSrc}
              stillSrc={portraitStillSrc}
              width={PORTRAIT_W}
              height={PORTRAIT_H}
              alt={portraitAlt}
            />
          </td>
        </tr>
      </tbody>
    </table>
  );
}
