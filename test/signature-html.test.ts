import { describe, it, expect } from "vitest";
import {
  buildSignatureHtml,
  buildSignatureText,
  signatureCharCount,
  SignatureTooLongError,
  MAX_SIGNATURE_CHARS,
  type SignatureData,
} from "../lib/signature-html";

const base: SignatureData = {
  name: "Jonathan Naal",
  title: "Head of Product",
  organization: "Plania",
  email: "jonathan@example.com",
  links: [
    { label: "Site", url: "https://example.com" },
    { label: "GitHub", url: "https://github.com/spykernv" },
  ],
  portraitUrl: "https://cdn.example.com/p/abc.gif",
  nameUrl: "https://cdn.example.com/n/abc.gif",
  portrait: { w: 112, h: 138 },
};

const d = (over: Partial<SignatureData> = {}): SignatureData => ({ ...base, ...over });

/**
 * These are the rules mail clients enforce, not a style guide. Each one has a client behind
 * it: `<style>` is deleted by Gmail, classes die with it, flexbox and media queries do not
 * exist in Word.
 */
describe("mail-client compatibility", () => {
  const html = buildSignatureHtml(base);

  it("never emits a <style> block", () => {
    expect(html).not.toMatch(/<style/i);
  });

  it("never emits a class attribute", () => {
    expect(html).not.toMatch(/\sclass\s*=/i);
  });

  it("never emits a media query", () => {
    expect(html).not.toMatch(/@media/i);
  });

  it("never emits flexbox or grid", () => {
    expect(html).not.toMatch(/display\s*:\s*(flex|grid|inline-flex)/i);
  });

  it("never emits a <script>", () => {
    expect(html).not.toMatch(/<script/i);
  });

  it("lays out with tables carrying the mail-safe attributes", () => {
    expect(html.startsWith("<table")).toBe(true);
    expect(html).toContain('cellpadding="0"');
    expect(html).toContain('cellspacing="0"');
    expect(html).toContain('border="0"');
    expect(html).toContain("border-collapse:collapse");
  });

  it("gives every image explicit width and height attributes, which Word needs", () => {
    const imgs = html.match(/<img[^>]*>/g) ?? [];
    expect(imgs).toHaveLength(2);
    for (const tag of imgs) {
      expect(tag).toMatch(/\swidth="\d+"/);
      expect(tag).toMatch(/\sheight="\d+"/);
    }
  });

  it("ships no web font, and a stack whose last resort exists everywhere", () => {
    expect(html).not.toMatch(/@font-face|fonts\.googleapis/i);
    expect(html).toContain("Arial");
    expect(html).toContain("sans-serif");
  });
});

describe("images and alt text", () => {
  it("gives both images alt text", () => {
    const imgs = buildSignatureHtml(base).match(/<img[^>]*>/g) ?? [];
    expect(imgs).toHaveLength(2);
    for (const tag of imgs) expect(tag).toMatch(/\salt="[^"]+"/);
  });

  it("uses the name as the wordmark's alt, since that is all a blocked-image reader sees", () => {
    const html = buildSignatureHtml(base);
    expect(html).toContain('alt="Jonathan Naal"');
  });

  it("escapes the name inside alt", () => {
    const html = buildSignatureHtml(d({ name: `Ben & Jerry's` }));
    expect(html).toContain(`alt="Ben &amp; Jerry&#39;s"`);
    expect(html).not.toContain(`alt="Ben & Jerry's"`);
  });

  it("halves the wordmark GIF by default and honours an explicit size", () => {
    // The renderer's wordmark canvas is 360x56, so the default display size is 180x28.
    expect(buildSignatureHtml(base)).toContain('width="180" height="28"');
    expect(buildSignatureHtml(d({ nameSize: { w: 96, h: 28 } }))).toContain(
      'width="96" height="28"',
    );
  });

  it("rounds fractional display sizes, because Word drops a fractional attribute", () => {
    const html = buildSignatureHtml(d({ portrait: { w: 112.4, h: 138.6 } }));
    expect(html).toContain('width="112" height="139"');
  });

  it("rejects a non-positive display size", () => {
    expect(() => buildSignatureHtml(d({ portrait: { w: 0, h: 138 } }))).toThrow(/positive/);
    expect(() => buildSignatureHtml(d({ portrait: { w: 112, h: NaN } }))).toThrow(/positive/);
  });
});

/**
 * The user pastes this markup into their own mail client, so a hostile URL is executed in
 * their session and then mailed to everyone they write to. Dropping beats sanitising: an
 * absent link is visible, a neutered one is not.
 */
describe("URL validation", () => {
  const hostile = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "  javascript:alert(1)  ",
    "java\nscript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
  ];

  it.each(hostile)("drops the link %s entirely", (url) => {
    const html = buildSignatureHtml(d({ links: [{ label: "Click", url }] }));
    expect(html).not.toContain("Click");
    expect(html.toLowerCase()).not.toContain("javascript");
    expect(html.toLowerCase()).not.toContain("vbscript");
    expect(html).not.toContain("data:text/html");
  });

  it("drops relative links, which no mail client can resolve", () => {
    for (const url of ["/about", "about.html", "//example.com", "example.com"]) {
      const html = buildSignatureHtml(d({ links: [{ label: "Relative", url }] }));
      expect(html).not.toContain("Relative");
    }
  });

  it("keeps http, https and mailto links", () => {
    const html = buildSignatureHtml(
      d({
        links: [
          { label: "Http", url: "http://example.com/a" },
          { label: "Https", url: "https://example.com/b" },
          { label: "Mail", url: "mailto:hi@example.com" },
        ],
      }),
    );
    expect(html).toContain('href="http://example.com/a"');
    expect(html).toContain('href="https://example.com/b"');
    expect(html).toContain('href="mailto:hi@example.com"');
  });

  it("drops a link with no label rather than rendering an invisible anchor", () => {
    const html = buildSignatureHtml(d({ links: [{ label: "   ", url: "https://example.com" }] }));
    expect(html).not.toContain("https://example.com");
  });

  it("throws on a portrait URL that is not absolute http(s)", () => {
    for (const url of ["/p/abc.gif", "abc.gif", "javascript:alert(1)", "mailto:a@b.co", ""]) {
      expect(() => buildSignatureHtml(d({ portraitUrl: url }))).toThrow(/absolute/);
    }
  });

  it("falls back to live text when the wordmark URL is unusable", () => {
    const html = buildSignatureHtml(d({ nameUrl: "javascript:alert(1)" }));
    expect(html).toContain("Jonathan Naal");
    expect((html.match(/<img/g) ?? []).length).toBe(1);
    expect(html.toLowerCase()).not.toContain("javascript");
  });

  it("rejects an e-mail address that could smuggle a scheme or break the mailto", () => {
    for (const email of [
      "not-an-address",
      "a@b",
      "a b@example.com",
      'a"@example.com',
      "javascript:alert(1)@example.com",
    ]) {
      expect(buildSignatureHtml(d({ email }))).not.toContain("mailto:");
    }
  });

  it("keeps a normal e-mail address as a mailto link", () => {
    const html = buildSignatureHtml(base);
    expect(html).toContain('href="mailto:jonathan@example.com"');
    expect(html).toContain(">jonathan@example.com</a>");
  });
});

describe("escaping", () => {
  it("escapes the five dangerous characters in every text field", () => {
    const html = buildSignatureHtml(
      d({
        name: `A & B`,
        title: `<b>Chief</b>`,
        organization: `O'Brien & Co`,
        nameUrl: undefined,
        links: [{ label: `"Blog" <new>`, url: "https://example.com" }],
      }),
    );
    expect(html).toContain("A &amp; B");
    expect(html).toContain("&lt;b&gt;Chief&lt;/b&gt;");
    expect(html).toContain("O&#39;Brien &amp; Co");
    expect(html).toContain("&quot;Blog&quot; &lt;new&gt;");
    expect(html).not.toContain("<b>Chief</b>");
  });

  it("does not let a crafted name close an attribute", () => {
    const html = buildSignatureHtml(d({ name: `x" onerror="alert(1)` }));
    // The literal text `onerror=` survives — as inert text. What must not exist is a live
    // attribute, which requires an unescaped quote after the `=`.
    expect(html).not.toMatch(/onerror\s*=\s*["']/);
    expect(html).toContain("&quot; onerror=&quot;");
  });

  it("escapes an ampersand in a URL so the href stays one URL", () => {
    const html = buildSignatureHtml(
      d({ links: [{ label: "Q", url: "https://example.com/?a=1&b=2" }] }),
    );
    expect(html).toContain('href="https://example.com/?a=1&amp;b=2"');
  });

  it("collapses newlines and control characters, which paste as visible blank rows", () => {
    const html = buildSignatureHtml(d({ title: "Head of\nProduct\t" }));
    expect(html).toContain("Head of Product");
    expect(html).not.toMatch(/[ -]/);
  });

  it("requires a name", () => {
    expect(() => buildSignatureHtml(d({ name: "   " }))).toThrow(/name is required/);
  });
});

describe("optional fields", () => {
  it("builds with nothing but a name, a title and a portrait", () => {
    const html = buildSignatureHtml({
      name: "Jonathan Naal",
      title: "Head of Product",
      links: [],
      portraitUrl: "https://cdn.example.com/p/abc.gif",
      portrait: { w: 112, h: 138 },
    });
    expect(html).toContain("Jonathan Naal");
    expect(html).toContain("Head of Product");
    expect(html).not.toContain("mailto:");
    expect((html.match(/<img/g) ?? []).length).toBe(1);
    expect(html).not.toContain("<a ");
  });

  it("omits the organization row when there is no organization", () => {
    expect(buildSignatureHtml(d({ organization: undefined }))).not.toContain("Plania");
  });

  it("omits the title row when the title is blank", () => {
    const html = buildSignatureHtml(d({ title: "  " }));
    expect(html).toContain("Jonathan Naal");
    expect(html).not.toContain("Head of Product");
  });

  it("ships the name as live monospace text when there is no wordmark", () => {
    const html = buildSignatureHtml(d({ nameUrl: undefined }));
    expect(html).toContain(">Jonathan Naal<");
    expect(html).toContain("monospace");
    expect((html.match(/<img/g) ?? []).length).toBe(1);
  });
});

/**
 * Gmail truncates a long signature silently. The first symptom is a recipient seeing half a
 * table, weeks later, so the failure has to happen here where someone is watching.
 */
describe("character budget", () => {
  it("reports the count in UTF-16 code units", () => {
    const html = buildSignatureHtml(base);
    expect(signatureCharCount(html)).toBe(html.length);
  });

  it("keeps a realistic signature far under the limit", () => {
    expect(signatureCharCount(buildSignatureHtml(base))).toBeLessThan(2500);
  });

  it("throws SignatureTooLongError past the limit", () => {
    const links = Array.from({ length: 200 }, (_, i) => ({
      label: `Link number ${i}`,
      url: `https://example.com/a-fairly-long-path-segment/${i}`,
    }));
    let err: unknown;
    try {
      buildSignatureHtml(d({ links }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SignatureTooLongError);
    const e = err as SignatureTooLongError;
    expect(e.count).toBeGreaterThan(MAX_SIGNATURE_CHARS);
    expect(e.limit).toBe(MAX_SIGNATURE_CHARS);
  });

  it("leaves headroom under Gmail's real cap", () => {
    expect(MAX_SIGNATURE_CHARS).toBeLessThan(10_000);
  });

  it("never embeds an image as base64, which alone would blow the budget", () => {
    expect(buildSignatureHtml(base)).not.toContain("data:image");
  });
});

describe("plain-text flavour", () => {
  it("lists the fields one per line and drops hostile links", () => {
    const text = buildSignatureText(
      d({ links: [{ label: "Bad", url: "javascript:alert(1)" }, ...base.links] }),
    );
    expect(text.split("\n")).toEqual([
      "Jonathan Naal",
      "Head of Product",
      "Plania",
      "jonathan@example.com",
      "Site: https://example.com/",
      "GitHub: https://github.com/spykernv",
    ]);
  });

  it("carries no markup", () => {
    expect(buildSignatureText(base)).not.toMatch(/[<>]/);
  });
});
