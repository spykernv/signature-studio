/**
 * A GIF89a reader — the mirror of `muxer.ts`, and the only way to compare what we encode with
 * what ffmpeg encoded.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE ONE IN `test/gif.test.ts`. That decoder is deliberately
 * an *independent reimplementation*: the round-trip test is only meaningful because the two
 * sides share no code, so importing this module there would quietly destroy the property the
 * test is bought with. This one has a different job — it must survive a file this project did
 * not write. `test/fixtures/reference-sig-a.gif` came out of ffmpeg with a 256-entry global
 * table and a background index of 255, and a real upload could just as easily arrive
 * interlaced or carrying local colour tables. So the test's decoder stays where it is, and
 * this one handles the whole format.
 *
 * WHAT "A FRAME" MEANS HERE. GIF frames are sub-rectangles painted onto a persistent canvas,
 * not pictures. Every `DecodedFrame.rgba` is therefore the FULL canvas as a viewer sees it
 * once that frame has been painted — which is the only representation two different encoders'
 * output can be compared in, since they will choose different rectangles for the same
 * animation.
 */

export interface DecodedFrame {
  /** The sub-rectangle this frame actually repainted. Useful for judging encoder efficiency. */
  rect: { x: number; y: number; w: number; h: number };
  delayCs: number;
  disposal: number;
  transparentIndex: number | null;
  /** Bytes of LZW payload for this frame, before sub-block framing. */
  dataBytes: number;
  /** The full canvas after this frame is painted, RGBA, `width * height * 4`. */
  rgba: Uint8ClampedArray;
}

export interface DecodedGif {
  /** "GIF89a" or "GIF87a". */
  signature: string;
  width: number;
  height: number;
  backgroundIndex: number;
  /** Flat RGB triples; empty when the file has no global colour table. */
  globalPalette: Uint8Array;
  /** Entries in the global colour table. */
  globalPaletteSize: number;
  /** NETSCAPE2.0 iteration count; 0 means forever. `null` when the block is absent. */
  loopCount: number | null;
  frames: DecodedFrame[];
}

class Reader {
  pos = 0;
  readonly b: Uint8Array;

  // Written out rather than as a TS parameter property so the file also runs under Node's
  // strip-only type stripping, which is how the harness numbers get reproduced from a script.
  constructor(b: Uint8Array) {
    this.b = b;
  }

  byte(): number {
    if (this.pos >= this.b.length) throw new Error(`gif: truncated at ${this.pos}`);
    return this.b[this.pos++];
  }
  u16(): number {
    const v = this.byte();
    return v | (this.byte() << 8);
  }
  ascii(n: number): string {
    let s = "";
    for (let i = 0; i < n; i += 1) s += String.fromCharCode(this.byte());
    return s;
  }
  bytes(n: number): Uint8Array {
    if (this.pos + n > this.b.length) throw new Error(`gif: truncated at ${this.pos}`);
    const v = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  /** Concatenate a chain of length-prefixed sub-blocks, terminated by a zero length. */
  blocks(): Uint8Array {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const n = this.byte();
      if (n === 0) break;
      const part = this.bytes(n);
      parts.push(part);
      total += part.length;
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

/**
 * Textbook GIF LZW: variable-width LSB-first codes, widening one code BEFORE the table fills.
 *
 * The off-by-one in that last clause is the classic way to write a decoder that reads most
 * files and corrupts a few, so it is spelled out: the width grows when `next` reaches
 * `1 << codeSize`, not after the code that would overflow has already been read.
 */
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
  const bitLimit = data.length * 8;

  while (outPos < pixelCount) {
    if (bitPos + codeSize > bitLimit) break; // ran dry; the caller reports the short read
    let code = 0;
    for (let i = 0; i < codeSize; i += 1) {
      code |= ((data[bitPos >> 3] >> (bitPos & 7)) & 1) << i;
      bitPos += 1;
    }

    if (code === eoi) break;
    if (code === clear) {
      codeSize = minCodeSize + 1;
      next = clear + 2;
      old = -1;
      continue;
    }
    if (old === -1) {
      if (code >= clear) throw new Error(`gif lzw: first code ${code} is not a literal`);
      first = suffix[code];
      out[outPos++] = first;
      old = code;
      continue;
    }

    let inCode = code;
    let sp = 0;
    if (code >= next) {
      if (code > next) throw new Error(`gif lzw: code ${code} beyond table (${next})`);
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

  if (outPos !== pixelCount) {
    throw new Error(`gif lzw: decoded ${outPos} of ${pixelCount} pixels`);
  }
  return out;
}

/** GIF's four-pass interlace: rows 0,8,16… then 4,12… then 2,6… then every odd row. */
const INTERLACE = [
  { start: 0, step: 8 },
  { start: 4, step: 8 },
  { start: 2, step: 4 },
  { start: 1, step: 2 },
];

function deinterlace(indices: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(indices.length);
  let src = 0;
  for (const { start, step } of INTERLACE) {
    for (let row = start; row < h; row += step, src += 1) {
      out.set(indices.subarray(src * w, src * w + w), row * w);
    }
  }
  return out;
}

export function decodeGif(bytes: Uint8Array): DecodedGif {
  const r = new Reader(bytes);
  const signature = r.ascii(6);
  if (signature !== "GIF89a" && signature !== "GIF87a") {
    throw new Error(`gif: bad signature ${JSON.stringify(signature)}`);
  }

  const width = r.u16();
  const height = r.u16();
  const packed = r.byte();
  const backgroundIndex = r.byte();
  r.byte(); // pixel aspect ratio

  const gctSize = packed & 0x80 ? 1 << ((packed & 7) + 1) : 0;
  const globalPalette = gctSize ? Uint8Array.from(r.bytes(gctSize * 3)) : new Uint8Array(0);

  const area = width * height;
  const canvas = new Uint8ClampedArray(area * 4);

  // The canvas starts transparent, not background-coloured. A conforming first frame is
  // full-canvas and opaque so this never shows; when it does show, every mail client this
  // targets renders it as the message background, and painting the GCT's background colour
  // instead would put a visible rectangle where the client would have shown white.
  const clearRect = (x: number, y: number, w: number, h: number): void => {
    for (let row = 0; row < h; row += 1) {
      const p = ((y + row) * width + x) * 4;
      canvas.fill(0, p, p + w * 4);
    }
  };

  const frames: DecodedFrame[] = [];
  let loopCount: number | null = null;

  // Graphic-control state is sticky in the format: it applies to the NEXT image descriptor and
  // is reset only by another control block. Hoisted out of the loop for exactly that reason.
  let disposal = 0;
  let delayCs = 0;
  let transparentIndex: number | null = null;

  for (;;) {
    const block = r.byte();
    if (block === 0x3b) break; // trailer

    if (block === 0x21) {
      const label = r.byte();
      if (label === 0xf9) {
        const size = r.byte();
        const gce = r.bytes(size);
        const flags = gce[0];
        disposal = (flags >> 2) & 7;
        delayCs = gce[1] | (gce[2] << 8);
        transparentIndex = flags & 1 ? gce[3] : null;
        r.blocks(); // terminator
      } else if (label === 0xff) {
        const size = r.byte();
        const id = r.ascii(size);
        const payload = r.blocks();
        if (id === "NETSCAPE2.0" && payload[0] === 1) {
          loopCount = payload[1] | (payload[2] << 8);
        }
      } else {
        // Comment (0xfe) and plain text (0x01). Plain text carries a 12-byte header before its
        // sub-blocks, so it cannot simply be skipped as a block chain.
        if (label === 0x01) r.bytes(r.byte());
        r.blocks();
      }
      continue;
    }

    if (block !== 0x2c) {
      throw new Error(`gif: unexpected block 0x${block.toString(16)} at ${r.pos - 1}`);
    }

    const x = r.u16();
    const y = r.u16();
    const w = r.u16();
    const h = r.u16();
    if (x + w > width || y + h > height) {
      throw new Error(`gif: frame rect ${x},${y} ${w}x${h} escapes the ${width}x${height} canvas`);
    }

    const imgPacked = r.byte();
    const lctSize = imgPacked & 0x80 ? 1 << ((imgPacked & 7) + 1) : 0;
    const localPalette = lctSize ? Uint8Array.from(r.bytes(lctSize * 3)) : null;
    const table = localPalette ?? globalPalette;
    const interlaced = (imgPacked & 0x40) !== 0;

    const minCodeSize = r.byte();
    const payload = r.blocks();
    const raw = lzwDecode(payload, minCodeSize, w * h);
    const indices = interlaced ? deinterlace(raw, w, h) : raw;

    // Disposal 3 restores what was on screen BEFORE this frame, so the snapshot has to be
    // taken before a single pixel of it is painted.
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
      dataBytes: payload.length,
      rgba: canvas.slice(),
    });

    if (disposal === 2) clearRect(x, y, w, h);
    else if (disposal === 3 && saved) canvas.set(saved);
  }

  return {
    signature,
    width,
    height,
    backgroundIndex,
    globalPalette,
    globalPaletteSize: gctSize,
    loopCount,
    frames,
  };
}

export interface FrameDiff {
  /** Mean absolute difference over every pixel, 0..255. */
  mean: number;
  /** Largest absolute difference any single pixel shows, 0..255. */
  max: number;
  /** Share of pixels differing by more than 2, as a percentage. */
  pctOver2: number;
}

/**
 * Compare two full canvases.
 *
 * A pixel's difference is the LARGEST of its three channel differences, not their average.
 * Both files here are greyscale so the two agree, but averaging would let a single wrong
 * channel — the exact shape a palette bug takes — be divided by three before anyone saw it.
 */
export function diffRgba(a: Uint8ClampedArray, b: Uint8ClampedArray): FrameDiff {
  if (a.length !== b.length) throw new Error(`diffRgba: ${a.length} vs ${b.length} bytes`);

  const n = a.length / 4;
  let sum = 0;
  let max = 0;
  let over = 0;

  for (let i = 0; i < n; i += 1) {
    const p = i * 4;
    const dr = Math.abs(a[p] - b[p]);
    const dg = Math.abs(a[p + 1] - b[p + 1]);
    const db = Math.abs(a[p + 2] - b[p + 2]);
    const d = dr > dg ? (dr > db ? dr : db) : dg > db ? dg : db;
    sum += d;
    if (d > max) max = d;
    if (d > 2) over += 1;
  }

  return { mean: sum / n, max, pctOver2: (over / n) * 100 };
}
