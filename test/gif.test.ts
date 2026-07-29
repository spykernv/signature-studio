import { describe, it, expect } from "vitest";
import {
  encodeGif,
  buildPalette,
  createQuantizer,
  bayerOffsets,
  BAYER8,
  type Frame,
} from "../lib/gif";

/**
 * The encoder is tested against an INDEPENDENT decoder written below, not against itself.
 *
 * That is the whole point of this file. A GIF encoder that emits a subtly malformed file — a
 * wrong sub-block length, an off-by-one in the LZW code width, a bad image-descriptor offset —
 * still produces bytes, and any test that only inspects those bytes with the encoder's own
 * assumptions will pass. The decoder here shares no code with the encoder: it walks the byte
 * stream the way a mail client's decoder does, composites the sub-rectangles honouring
 * disposal and transparency, and hands back a finished canvas per frame. If the two disagree,
 * one of them is wrong, and that is exactly the signal wanted.
 */

/* =========================================================================== decoder ===== */

interface DecodedFrame {
  rect: { x: number; y: number; w: number; h: number };
  delayCs: number;
  disposal: number;
  transparentIndex: number | null;
  /** The full canvas as a viewer sees it after this frame is painted. RGBA. */
  rgba: Uint8Array;
}

interface DecodedGif {
  signature: string;
  width: number;
  height: number;
  backgroundIndex: number;
  globalPalette: Uint8Array;
  /** Extra iterations from the NETSCAPE2.0 block; 0 = forever. null = block absent. */
  loopCount: number | null;
  frames: DecodedFrame[];
}

class Reader {
  pos = 0;
  constructor(readonly b: Uint8Array) {}
  byte(): number {
    return this.b[this.pos++];
  }
  u16(): number {
    const v = this.b[this.pos] | (this.b[this.pos + 1] << 8);
    this.pos += 2;
    return v;
  }
  ascii(n: number): string {
    let s = "";
    for (let i = 0; i < n; i += 1) s += String.fromCharCode(this.b[this.pos++]);
    return s;
  }
  bytes(n: number): Uint8Array {
    const v = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  /** Concatenate a chain of length-prefixed sub-blocks, terminated by a zero length. */
  blocks(): Uint8Array {
    const parts: Uint8Array[] = [];
    for (;;) {
      const n = this.byte();
      if (n === 0) break;
      parts.push(this.bytes(n));
    }
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

/** Textbook GIF LZW: variable-width LSB-first codes, widening one code before the table fills. */
function lzwDecode(data: Uint8Array, minCodeSize: number, pixelCount: number): Uint8Array {
  const MAX = 4096;
  const prefix = new Int32Array(MAX);
  const suffix = new Uint8Array(MAX);
  const stack = new Uint8Array(MAX + 1);
  const out = new Uint8Array(pixelCount);

  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  for (let i = 0; i < clear; i += 1) {
    prefix[i] = -1;
    suffix[i] = i;
  }

  let codeSize = minCodeSize + 1;
  let next = clear + 2;
  let bitPos = 0;
  let outPos = 0;
  let old = -1;
  let first = 0;

  const readCode = (): number => {
    let code = 0;
    for (let i = 0; i < codeSize; i += 1) {
      code |= ((data[bitPos >> 3] >> (bitPos & 7)) & 1) << i;
      bitPos += 1;
    }
    return code;
  };

  while (outPos < pixelCount) {
    if (bitPos + codeSize > data.length * 8) throw new Error("LZW: ran out of bits");
    const code = readCode();
    if (code === eoi) break;
    if (code === clear) {
      codeSize = minCodeSize + 1;
      next = clear + 2;
      old = -1;
      continue;
    }
    if (old === -1) {
      if (code >= clear) throw new Error(`LZW: first code ${code} is not a literal`);
      first = suffix[code];
      out[outPos++] = first;
      old = code;
      continue;
    }

    let inCode = code;
    let sp = 0;
    if (code >= next) {
      if (code > next) throw new Error(`LZW: code ${code} beyond table (${next})`);
      stack[sp++] = first; // the KwKwK case
      inCode = old;
    }
    while (inCode >= clear) {
      stack[sp++] = suffix[inCode];
      inCode = prefix[inCode];
    }
    first = suffix[inCode];
    stack[sp++] = first;
    while (sp > 0 && outPos < pixelCount) out[outPos++] = stack[--sp];

    if (next < MAX) {
      prefix[next] = old;
      suffix[next] = first;
      next += 1;
      if (next === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    old = code;
  }

  if (outPos !== pixelCount) throw new Error(`LZW: decoded ${outPos} of ${pixelCount} pixels`);
  return out;
}

function decodeGif(bytes: Uint8Array): DecodedGif {
  const r = new Reader(bytes);
  const signature = r.ascii(6);
  const width = r.u16();
  const height = r.u16();
  const packed = r.byte();
  const backgroundIndex = r.byte();
  r.byte(); // pixel aspect ratio

  const gctSize = packed & 0x80 ? 1 << ((packed & 7) + 1) : 0;
  const globalPalette = gctSize ? Uint8Array.from(r.bytes(gctSize * 3)) : new Uint8Array(0);

  const canvas = new Uint8Array(width * height * 4);
  if (gctSize) {
    for (let i = 0; i < width * height; i += 1) {
      canvas[4 * i] = globalPalette[3 * backgroundIndex];
      canvas[4 * i + 1] = globalPalette[3 * backgroundIndex + 1];
      canvas[4 * i + 2] = globalPalette[3 * backgroundIndex + 2];
      canvas[4 * i + 3] = 255;
    }
  }

  const frames: DecodedFrame[] = [];
  let loopCount: number | null = null;
  let disposal = 0;
  let delayCs = 0;
  let transparentIndex: number | null = null;

  for (;;) {
    const block = r.byte();
    if (block === 0x3b) break;

    if (block === 0x21) {
      const label = r.byte();
      if (label === 0xf9) {
        const size = r.byte();
        expect(size).toBe(4);
        const flags = r.byte();
        disposal = (flags >> 2) & 7;
        delayCs = r.u16();
        const idx = r.byte();
        transparentIndex = flags & 1 ? idx : null;
        expect(r.byte()).toBe(0); // block terminator
      } else if (label === 0xff) {
        const size = r.byte();
        const id = r.ascii(size);
        const payload = r.blocks();
        if (id === "NETSCAPE2.0" && payload[0] === 1) {
          loopCount = payload[1] | (payload[2] << 8);
        }
      } else {
        r.blocks();
      }
      continue;
    }

    if (block !== 0x2c) throw new Error(`unexpected block 0x${block.toString(16)} at ${r.pos - 1}`);

    const x = r.u16();
    const y = r.u16();
    const w = r.u16();
    const h = r.u16();
    const imgPacked = r.byte();
    const lctSize = imgPacked & 0x80 ? 1 << ((imgPacked & 7) + 1) : 0;
    const localPalette = lctSize ? Uint8Array.from(r.bytes(lctSize * 3)) : null;
    const table = localPalette ?? globalPalette;
    expect(imgPacked & 0x40).toBe(0); // this encoder never interlaces

    const minCodeSize = r.byte();
    const indices = lzwDecode(r.blocks(), minCodeSize, w * h);

    const saved = disposal === 3 ? canvas.slice() : null;

    for (let row = 0; row < h; row += 1) {
      for (let col = 0; col < w; col += 1) {
        const idx = indices[row * w + col];
        if (transparentIndex !== null && idx === transparentIndex) continue;
        const p = ((y + row) * width + (x + col)) * 4;
        canvas[p] = table[3 * idx];
        canvas[p + 1] = table[3 * idx + 1];
        canvas[p + 2] = table[3 * idx + 2];
        canvas[p + 3] = 255;
      }
    }

    frames.push({
      rect: { x, y, w, h },
      delayCs,
      disposal,
      transparentIndex,
      rgba: canvas.slice(),
    });

    if (disposal === 2) {
      for (let row = 0; row < h; row += 1) {
        for (let col = 0; col < w; col += 1) {
          const p = ((y + row) * width + (x + col)) * 4;
          canvas[p] = table[3 * backgroundIndex];
          canvas[p + 1] = table[3 * backgroundIndex + 1];
          canvas[p + 2] = table[3 * backgroundIndex + 2];
          canvas[p + 3] = 255;
        }
      }
    } else if (disposal === 3 && saved) {
      canvas.set(saved);
    }
  }

  return { signature, width, height, backgroundIndex, globalPalette, loopCount, frames };
}

/* ========================================================================== fixtures ===== */

/** Node has no canvas, so frames are hand-built. `px` returns a packed 0xRRGGBB. */
function frameOf(w: number, h: number, px: (x: number, y: number) => number): Frame {
  const data = new Uint8ClampedArray(w * h * 4);
  let p = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1, p += 4) {
      const c = px(x, y);
      data[p] = (c >> 16) & 0xff;
      data[p + 1] = (c >> 8) & 0xff;
      data[p + 2] = c & 0xff;
      data[p + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

const grey = (v: number) => (v << 16) | (v << 8) | v;
const WHITE = grey(255);

/** Deterministic pseudo-random in [0,1), same trick as the reference's noise(). */
const rand = (a: number, b: number) => {
  const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return n - Math.floor(n);
};

function pixelAt(f: DecodedFrame, width: number, x: number, y: number): [number, number, number] {
  const p = (y * width + x) * 4;
  return [f.rgba[p], f.rgba[p + 1], f.rgba[p + 2]];
}

/**
 * Frames whose colours are all 32 apart. Chosen so the round-trip must be EXACT: median cut
 * gives every distinct colour its own singleton box (so the palette entry is the colour), and
 * a Bayer offset of at most ±4 cannot push any of them across the 16-unit midpoint to a
 * neighbour. Anything less than exact equality here is a bug, not quantisation error.
 */
function separableFrames(w: number, h: number, count: number): Frame[] {
  return Array.from({ length: count }, (_, i) =>
    frameOf(w, h, (x, y) => {
      if (i === 0) return WHITE; // frame 0 is the resting state: a clean, complete picture
      const inBlock = x >= 4 && x < 4 + 2 * i && y >= 3 && y < 3 + i;
      return inBlock ? grey(32 * ((x + y + i) % 8)) : WHITE;
    }),
  );
}

/* ============================================================================= tests ===== */

describe("container", () => {
  const frames = separableFrames(32, 24, 6);
  const bytes = encodeGif(frames, {
    width: 32,
    height: 24,
    delayCs: 4,
    maxColors: 24,
    dither: "bayer",
  });
  const gif = decodeGif(bytes);

  it("starts with the exact GIF89a signature", () => {
    expect(gif.signature).toBe("GIF89a");
    // Byte-level, not just via the decoder — the signature is the one thing a client sniffs.
    expect([...bytes.subarray(0, 6)]).toEqual([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(bytes[bytes.length - 1]).toBe(0x3b);
  });

  it("declares the canvas size", () => {
    expect(gif.width).toBe(32);
    expect(gif.height).toBe(24);
  });

  it("loops forever via NETSCAPE2.0", () => {
    expect(gif.loopCount).toBe(0);
  });

  it("emits every frame, each at exactly 4 centiseconds", () => {
    expect(gif.frames).toHaveLength(6);
    for (const f of gif.frames) expect(f.delayCs).toBe(4);
  });

  it("leaves each frame in place rather than disposing it", () => {
    for (const f of gif.frames) expect(f.disposal).toBe(1);
  });

  it("points the background index at pure white", () => {
    const b = gif.backgroundIndex;
    expect([
      gif.globalPalette[3 * b],
      gif.globalPalette[3 * b + 1],
      gif.globalPalette[3 * b + 2],
    ]).toEqual([255, 255, 255]);
  });
});

describe("round-trip", () => {
  for (const dither of ["none", "bayer"] as const) {
    it(`reproduces every pixel exactly with dither=${dither}`, () => {
      const frames = separableFrames(32, 24, 6);
      const gif = decodeGif(
        encodeGif(frames, { width: 32, height: 24, delayCs: 4, maxColors: 24, dither }),
      );

      expect(gif.frames).toHaveLength(frames.length);
      frames.forEach((src, i) => {
        const got = gif.frames[i];
        for (let p = 0; p < src.data.length; p += 4) {
          const px = (p / 4) % 32;
          const py = Math.floor(p / 4 / 32);
          expect({ i, px, py, rgb: [got.rgba[p], got.rgba[p + 1], got.rgba[p + 2]] }).toEqual({
            i,
            px,
            py,
            rgb: [src.data[p], src.data[p + 1], src.data[p + 2]],
          });
        }
      });
    });
  }

  /**
   * A 256x256 field of noise exhausts LZW's 4096-entry table several times over, which forces
   * the encoder down its table-reset branch — emit a clear code, drop back to the initial code
   * width, start again. That branch runs on the real portrait's first frame and nowhere in the
   * small fixtures above; if its interaction with the variable code width is off by one, every
   * pixel after the first reset is garbage.
   */
  it("survives the LZW table filling and being reset", () => {
    const N = 256;
    const src = frameOf(N, N, (x, y) => grey(32 * Math.floor(rand(x, y) * 8)));
    const gif = decodeGif(
      encodeGif([src], { width: N, height: N, delayCs: 4, maxColors: 24, dither: "none" }),
    );
    let mismatches = 0;
    for (let p = 0; p < src.data.length; p += 4) {
      if (gif.frames[0].rgba[p] !== src.data[p]) mismatches += 1;
    }
    expect(mismatches).toBe(0);
  });

  it("survives a single frame", () => {
    const gif = decodeGif(
      encodeGif([frameOf(8, 8, (x) => grey(x * 32 > 255 ? 255 : x * 32))], {
        width: 8,
        height: 8,
        delayCs: 4,
        maxColors: 16,
        dither: "none",
      }),
    );
    expect(gif.frames).toHaveLength(1);
    expect(gif.frames[0].rect).toEqual({ x: 0, y: 0, w: 8, h: 8 });
  });
});

describe("pure white survives quantisation", () => {
  it("decodes an all-white frame to exactly 255,255,255", () => {
    const gif = decodeGif(
      encodeGif([frameOf(16, 16, () => WHITE)], {
        width: 16,
        height: 16,
        delayCs: 4,
        maxColors: 24,
        dither: "bayer",
      }),
    );
    const f = gif.frames[0];
    for (let p = 0; p < f.rgba.length; p += 4) {
      expect([f.rgba[p], f.rgba[p + 1], f.rgba[p + 2]]).toEqual([255, 255, 255]);
    }
  });

  /**
   * The exact failure the reference hit: with stats_mode=diff a white background contributes
   * nothing to the histogram, white loses its palette slot, and the signature renders as a
   * faint grey rectangle on Gmail's white body. Here white is a single never-changing pixel
   * surrounded by noise — the most hostile version of that case.
   */
  it("keeps a static white pixel exact even when stats_mode=diff never counts it", () => {
    const W = 16;
    const H = 16;
    const frames = Array.from({ length: 12 }, (_, i) =>
      frameOf(W, H, (x, y) =>
        x === 0 && y === 0 ? WHITE : grey(Math.floor(rand(x + i * 7, y) * 200)),
      ),
    );
    const gif = decodeGif(
      encodeGif(frames, {
        width: W,
        height: H,
        delayCs: 4,
        maxColors: 24,
        dither: "bayer",
        statsMode: "diff",
      }),
    );
    for (const f of gif.frames) expect(pixelAt(f, W, 0, 0)).toEqual([255, 255, 255]);
  });

  it("puts an exact white entry in the palette", () => {
    const p = buildPalette([frameOf(8, 8, (x) => (x < 4 ? WHITE : grey(120)))], {
      maxColors: 24,
      statsMode: "full",
    });
    expect(p.whiteIndex).toBeGreaterThanOrEqual(0);
    const w = p.whiteIndex;
    expect([p.rgb[3 * w], p.rgb[3 * w + 1], p.rgb[3 * w + 2]]).toEqual([255, 255, 255]);
  });

  it("reserves nothing when the frames contain no pure white", () => {
    const p = buildPalette([frameOf(8, 8, () => grey(10))], { maxColors: 24, statsMode: "full" });
    expect(p.whiteIndex).toBe(-1);
  });
});

describe("sub-rectangle frames", () => {
  const W = 40;
  const H = 30;
  // A 6x6 block that walks diagonally across a white canvas — the smallest thing that forces
  // a bounding box away from the origin on every axis.
  const frames = Array.from({ length: 8 }, (_, i) =>
    frameOf(W, H, (x, y) =>
      i > 0 && x >= 5 + 2 * i && x < 11 + 2 * i && y >= 4 + i && y < 10 + i ? grey(0) : WHITE,
    ),
  );
  const gif = decodeGif(
    encodeGif(frames, { width: W, height: H, delayCs: 4, maxColors: 24, dither: "none" }),
  );

  it("emits frame 0 full-canvas so Outlook's single frame is complete", () => {
    expect(gif.frames[0].rect).toEqual({ x: 0, y: 0, w: W, h: H });
    expect(gif.frames[0].transparentIndex).toBeNull();
  });

  it("emits later frames at a non-zero offset — the thing gifenc cannot do", () => {
    const offset = gif.frames.slice(1).filter((f) => f.rect.x > 0 && f.rect.y > 0);
    expect(offset.length).toBeGreaterThan(0);
    for (const f of gif.frames) {
      expect(f.rect.x + f.rect.w).toBeLessThanOrEqual(W);
      expect(f.rect.y + f.rect.h).toBeLessThanOrEqual(H);
    }
  });

  it("keeps those rectangles far smaller than the canvas", () => {
    for (const f of gif.frames.slice(1)) {
      expect(f.rect.w * f.rect.h).toBeLessThan((W * H) / 4);
    }
  });

  it("still composites to the right picture", () => {
    frames.forEach((src, i) => {
      const got = gif.frames[i];
      for (let p = 0; p < src.data.length; p += 4) {
        expect([got.rgba[p], got.rgba[p + 1], got.rgba[p + 2]]).toEqual([
          src.data[p],
          src.data[p + 1],
          src.data[p + 2],
        ]);
      }
    });
  });
});

describe("held frames", () => {
  const W = 24;
  const H = 24;
  const moving = frameOf(W, H, (x, y) => (x < 6 && y < 6 ? grey(0) : WHITE));
  const frames = [frameOf(W, H, () => WHITE), moving, ...Array.from({ length: 20 }, () => moving)];
  const bytes = encodeGif(frames, {
    width: W,
    height: H,
    delayCs: 4,
    maxColors: 24,
    dither: "bayer",
  });
  const gif = decodeGif(bytes);

  it("emits an unchanged frame anyway, to hold the timing", () => {
    expect(gif.frames).toHaveLength(frames.length);
    for (const f of gif.frames) expect(f.delayCs).toBe(4);
  });

  it("makes it a single pixel", () => {
    for (const f of gif.frames.slice(2)) expect(f.rect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("costs almost nothing", () => {
    const held = bytes;
    const short = encodeGif(frames.slice(0, 2), {
      width: W,
      height: H,
      delayCs: 4,
      maxColors: 24,
      dither: "bayer",
    });
    // 20 extra held frames must cost under 25 bytes each.
    expect(held.length - short.length).toBeLessThan(20 * 25);
  });

  it("shows the held picture, not a blank one", () => {
    for (const f of gif.frames.slice(1)) {
      expect(pixelAt(f, W, 2, 2)).toEqual([0, 0, 0]);
      expect(pixelAt(f, W, 20, 20)).toEqual([255, 255, 255]);
    }
  });
});

describe("ordered dither", () => {
  it("is ffmpeg's Bayer matrix, which is the TRANSPOSE of the textbook one", () => {
    // This test used to hardcode the textbook matrix, and passed — while the encoder dithered
    // against a pattern leaning the wrong way. It was asserting the implementation's choice,
    // not the requirement. What the requirement actually is: reproduce
    // `paletteuse=dither=bayer`, so the oracle has to be ffmpeg's own construction.
    //
    // prettier-ignore
    const textbook = [
       0, 32,  8, 40,  2, 34, 10, 42,
      48, 16, 56, 24, 50, 18, 58, 26,
      12, 44,  4, 36, 14, 46,  6, 38,
      60, 28, 52, 20, 62, 30, 54, 22,
       3, 35, 11, 43,  1, 33,  9, 41,
      51, 19, 59, 27, 49, 17, 57, 25,
      15, 47,  7, 39, 13, 45,  5, 37,
      63, 31, 55, 23, 61, 29, 53, 21,
    ];

    // The transpose of the textbook matrix, which is what libavfilter/vf_paletteuse.c produces.
    const expected = Array.from({ length: 64 }, (_, i) => textbook[((i & 7) << 3) | (i >> 3)]);
    expect([...BAYER8]).toEqual(expected);

    // …and it is still a Bayer matrix: a permutation of 0..63.
    expect([...BAYER8].sort((a, b) => a - b)).toEqual(Array.from({ length: 64 }, (_, i) => i));

    // The two differ on every cell off the diagonal — this is not a rounding quibble.
    const agreeing = [...BAYER8].filter((v, i) => v === textbook[i]).length;
    expect(agreeing).toBe(8);
  });

  it("reproduces ffmpeg's bayer_scale=3 range of [-4, +3]", () => {
    const o = bayerOffsets(3);
    expect(Math.min(...o)).toBe(-4);
    expect(Math.max(...o)).toBe(3);
    expect(new Set(o).size).toBe(8);
  });

  it("shrinks as bayer_scale rises, as ffmpeg documents", () => {
    for (let s = 0; s <= 5; s += 1) {
      const o = bayerOffsets(s);
      expect(Math.max(...o) - Math.min(...o)).toBe((63 >> s) === 0 ? 1 : 63 >> s);
    }
    expect(() => bayerOffsets(6)).toThrow();
  });

  it("dither=none leaves a flat area perfectly flat", () => {
    const f = frameOf(16, 16, (x, y) => (x + y < 8 ? WHITE : grey(100)));
    const palette = buildPalette([f], { maxColors: 24, statsMode: "full" });
    const out = new Uint8Array(16 * 16);
    createQuantizer(palette, "none", 3)(f, out);
    const flat = new Set<number>();
    for (let y = 8; y < 16; y += 1) for (let x = 8; x < 16; x += 1) flat.add(out[y * 16 + x]);
    expect(flat.size).toBe(1);
  });

  it("dither=bayer breaks up a gradient the palette cannot hold", () => {
    // 64 grey levels into 8 palette entries: undithered this is 8 flat plateaus with 7 hard
    // steps. The palette entries land ~8 apart, so the ±4 offset is exactly enough to make
    // pixels near a boundary flip — which is the whole mechanism.
    const f = frameOf(64, 8, (x) => grey(x));
    const palette = buildPalette([f], { maxColors: 8, statsMode: "full" });
    const plain = new Uint8Array(64 * 8);
    const dithered = new Uint8Array(64 * 8);
    createQuantizer(palette, "none", 3)(f, plain);
    createQuantizer(palette, "bayer", 3)(f, dithered);

    const transitions = (a: Uint8Array, row: number) => {
      let n = 0;
      for (let x = 1; x < 64; x += 1) if (a[row * 64 + x] !== a[row * 64 + x - 1]) n += 1;
      return n;
    };
    expect(transitions(dithered, 0)).toBeGreaterThan(transitions(plain, 0));

    // A column is a constant colour, so undithered every row is identical. Bayer's whole point
    // is that it varies with y as well — that is what turns a step into a texture.
    const rowsDiffer = (a: Uint8Array) => {
      for (let x = 0; x < 64; x += 1) if (a[x] !== a[64 + x]) return true;
      return false;
    };
    expect(rowsDiffer(plain)).toBe(false);
    expect(rowsDiffer(dithered)).toBe(true);
  });

  it("never dithers a pure white pixel", () => {
    // White beside a mid grey: a -4 Bayer offset on white lands at 251, which is nearer the
    // 251-ish box mean than to 255 — the grey-rectangle bug arriving through the dither.
    const f = frameOf(16, 16, (x) => (x < 8 ? WHITE : grey(250)));
    const palette = buildPalette([f], { maxColors: 24, statsMode: "full" });
    const out = new Uint8Array(16 * 16);
    createQuantizer(palette, "bayer", 3)(f, out);
    for (let y = 0; y < 16; y += 1) {
      for (let x = 0; x < 8; x += 1) expect(out[y * 16 + x]).toBe(palette.whiteIndex);
    }
  });
});

describe("palette", () => {
  it("never exceeds maxColors", () => {
    const f = frameOf(64, 64, (x, y) => grey(Math.floor(rand(x, y) * 256)));
    for (const maxColors of [2, 8, 24, 64]) {
      const p = buildPalette([f], { maxColors, statsMode: "full" });
      expect(p.size).toBeLessThanOrEqual(maxColors);
    }
  });

  it("rejects a colour budget the muxer cannot carry", () => {
    const f = frameOf(4, 4, () => WHITE);
    expect(() => buildPalette([f], { maxColors: 1, statsMode: "full" })).toThrow();
    expect(() => buildPalette([f], { maxColors: 256, statsMode: "full" })).toThrow();
  });

  it("is exact when the image has fewer colours than the budget", () => {
    const used = [0, 32, 64, 96, 255];
    const f = frameOf(10, 10, (x) => grey(used[x % used.length]));
    const p = buildPalette([f], { maxColors: 24, statsMode: "full" });
    const got = new Set<number>();
    for (let i = 0; i < p.size; i += 1) got.add(p.rgb[3 * i]);
    expect([...got].sort((a, b) => a - b)).toEqual(used);
  });

  it("spends its budget on what moves when stats_mode=diff", () => {
    // A static background of many greys, plus two pixels that alternate between two extremes.
    // "full" describes the background; "diff" describes the movement.
    const W = 32;
    const H = 32;
    const bg = (x: number, y: number) => grey(60 + ((x * 3 + y * 5) % 40));
    const frames = [0, 1, 0, 1].map((phase) =>
      frameOf(W, H, (x, y) => (x === 1 && y === 1 ? grey(phase ? 200 : 10) : bg(x, y))),
    );
    const diff = buildPalette(frames, { maxColors: 4, statsMode: "diff" });
    const full = buildPalette(frames, { maxColors: 4, statsMode: "full" });
    const spread = (p: typeof diff) => {
      let lo = 255;
      let hi = 0;
      for (let i = 0; i < p.size; i += 1) {
        lo = Math.min(lo, p.rgb[3 * i]);
        hi = Math.max(hi, p.rgb[3 * i]);
      }
      return hi - lo;
    };
    expect(spread(diff)).toBeGreaterThan(spread(full));
  });
});

describe("input validation", () => {
  const f = frameOf(4, 4, () => WHITE);
  const base = { width: 4, height: 4, delayCs: 4, maxColors: 24, dither: "none" } as const;

  it("refuses an empty sequence", () => {
    expect(() => encodeGif([], base)).toThrow(/at least one frame/);
  });

  it("refuses a frame of the wrong size", () => {
    expect(() => encodeGif([f, frameOf(5, 4, () => WHITE)], base)).toThrow(/frame 1/);
  });

  it("refuses a non-integer delay", () => {
    expect(() => encodeGif([f], { ...base, delayCs: 4.5 })).toThrow(/delayCs/);
  });
});

describe("size budget", () => {
  /**
   * The real shape of the problem: a 224x276 canvas whose photograph never moves and whose
   * bands sweep across it for a third of the loop. An email signature is refetched on every
   * open, so 70 KB is a hard ceiling — this is the assertion that would catch a regression
   * back to full-canvas frames, which for this content weighs several hundred KB.
   */
  it("keeps 110 frames of a mostly-static loop under 70 KB", () => {
    const W = 224;
    const H = 276;
    const photo = (x: number, y: number) => {
      const inside = x >= 8 && x < W - 8 && y >= 8 && y < H - 8;
      if (!inside) return WHITE;
      return grey(Math.floor(40 + 170 * Math.abs(Math.sin((x + y * 1.7) / 90))));
    };
    const frames = Array.from({ length: 110 }, (_, i) =>
      frameOf(W, H, (x, y) => {
        // Bands park off the photo between frames 12 and 54, sliding along a 0.175 lean.
        if (i >= 12 && i < 54) {
          const travel = ((i - 12) / 42) * (H + 60) - 30;
          const edge = travel - 0.175 * x;
          if (y > edge && y < edge + 70) return WHITE;
        }
        return photo(x, y);
      }),
    );

    const bytes = encodeGif(frames, {
      width: W,
      height: H,
      delayCs: 4,
      maxColors: 24,
      dither: "bayer",
    });
    const gif = decodeGif(bytes);

    expect(gif.frames).toHaveLength(110);
    expect(bytes.length).toBeLessThan(70 * 1024);
  });
});
