/**
 * GIF89a muxer.
 *
 * WHY THIS IS HAND-WRITTEN RATHER THAN `gifenc`. gifenc's `encodeImageDescriptor` is:
 *
 *     function encodeImageDescriptor(stream, width, height, localPalette) {
 *       stream.writeByte(0x2c);
 *       writeUInt16(stream, 0); // x position
 *       writeUInt16(stream, 0); // y position
 *       ...
 *
 * The x/y offsets are literal zeros with no way to pass anything else, so every frame it emits
 * is full-canvas. That is fatal here: 109 of the 110 frames change only a small band of the
 * 224x276 canvas, and emitting only the changed rectangle is precisely what keeps the file
 * inside the ~70 KB an email signature is allowed to weigh. So gifenc's LZW core is vendored
 * (MIT, attribution below) and everything above it is written here.
 *
 * VENDORED CODE — lzwEncode() below is adapted from gifenc (https://github.com/mattdesl/gifenc),
 * MIT (c) 2017 Matt DesLauriers, itself descended from Kevin Weiner's LZWEncoder.java via
 * Thibault Imbert and Johan Nordberg, with V8 tuning by Matt DesLauriers and Mathieu Henri.
 * Changes here: TypeScript types, the unused width/height parameters dropped, and output routed
 * into this file's ByteStream. The compression logic is untouched — it is a 40-year-old,
 * exhaustively-validated implementation and there is nothing to improve in it.
 *
 * WHAT THE FILE LOOKS LIKE:
 *   "GIF89a" | logical screen descriptor | global colour table | NETSCAPE2.0 loop extension
 *   then per frame: graphic control extension | image descriptor (x, y, w, h) | LZW data
 *   then 0x3B.
 *
 * Every frame uses disposal method 1 ("do not dispose"), so each sub-rectangle paints on top of
 * the accumulated canvas. Frame 0 is always full-canvas and fully opaque, which is what lets
 * the loop restart cleanly without a flash — and frame 0 is also the only frame Outlook 2016/
 * 2019 ever renders, so it has to be a complete picture on its own.
 */

import {
  buildPalette,
  createQuantizer,
  type DitherMode,
  type Frame,
  type Palette,
  type StatsMode,
} from "./palette";

export interface GifOptions {
  width: number;
  height: number;
  /**
   * Frame delay in CENTISECONDS — GIF's native unit. 4 gives exactly 25 fps; 24 or 30 fps land
   * on 4.17cs / 3.33cs, get rounded by the client, and the loop judders.
   */
  delayCs: number;
  /** Real colours in the palette. One further slot is reserved internally for transparency. */
  maxColors: number;
  dither: DitherMode;
  /** ffmpeg's bayer_scale. 3 is the reference value; ignored when dither is "none". */
  bayerScale?: number;
  /** ffmpeg's palettegen stats_mode. See palette.ts for why "diff" is safe as the default. */
  statsMode?: StatsMode;
}

/** Disposal 1 — leave the frame in place. The only method used here; see the file header. */
const DISPOSE_LEAVE = 1;

/**
 * Encode frames into a GIF89a.
 *
 * `frames` is consumed eagerly: the palette has to see every frame before the first one can be
 * written, so there is no streaming variant to be had. At 224x276x110 that is ~27 MB of RGBA
 * held at once, which is fine inside a worker and is the price of a palette fitted to the whole
 * loop rather than to its first frame.
 */
export function encodeGif(frames: Iterable<Frame>, opts: GifOptions): Uint8Array {
  const { width, height, delayCs, maxColors, dither } = opts;
  const bayerScale = opts.bayerScale ?? 3;
  const statsMode = opts.statsMode ?? "diff";

  assertU16("width", width, 1);
  assertU16("height", height, 1);
  assertU16("delayCs", delayCs, 0);

  const list = [...frames];
  if (list.length === 0) throw new Error("encodeGif: needs at least one frame");
  for (let i = 0; i < list.length; i += 1) {
    const f = list[i];
    if (f.width !== width || f.height !== height) {
      throw new RangeError(
        `encodeGif: frame ${i} is ${f.width}x${f.height}, expected ${width}x${height}`,
      );
    }
    if (f.data.length !== width * height * 4) {
      throw new RangeError(`encodeGif: frame ${i} has ${f.data.length} bytes of RGBA data`);
    }
  }

  const palette = buildPalette(list, { maxColors, statsMode });
  const quantize = createQuantizer(palette, dither, bayerScale);

  // The colour table is padded to the next power of two that leaves at least one slot spare,
  // and that spare slot becomes the transparent index. Because the padding entries are written
  // as black filler anyway, transparency is effectively free here: it costs no real colour.
  const tableSize = colorTableSize(palette.size + 1);
  const transparentIndex = palette.size;
  const codeSize = Math.max(2, Math.log2(tableSize));

  const out = new ByteStream(1 << 17);
  out.ascii("GIF89a");
  writeLogicalScreenDescriptor(out, width, height, tableSize, palette);
  writeColorTable(out, palette, tableSize);
  writeNetscapeLoop(out, 0);

  const area = width * height;
  let prev: Uint8Array | null = null;
  let cur: Uint8Array = new Uint8Array(area);
  const scratch = new Uint8Array(area);

  // Everything a frame needs beyond its own pixels, allocated once. The LZW scratch buffers in
  // particular are ~40 KB and would otherwise be reallocated 110 times.
  const ctx: FrameContext = {
    transparentIndex,
    delayCs,
    codeSize,
    accum: new Uint8Array(256),
    htab: new Int32Array(LZW_HSIZE),
    codetab: new Int32Array(LZW_HSIZE),
  };

  for (const frame of list) {
    quantize(frame, cur);

    const rect =
      prev === null ? { x: 0, y: 0, w: width, h: height } : changedRect(prev, cur, width, height);

    if (rect === null) {
      // Nothing moved. The frame still has to exist — it is what holds the timing — so emit the
      // smallest legal one: a single pixel repainted with the colour it already has. ~15 bytes.
      scratch[0] = cur[0];
      writeFrame(out, { x: 0, y: 0, w: 1, h: 1 }, scratch.subarray(0, 1), false, ctx);
    } else {
      const transparent = extractRect(cur, prev, rect, width, transparentIndex, scratch);
      writeFrame(out, rect, scratch.subarray(0, rect.w * rect.h), transparent, ctx);
    }

    // Swap rather than copy: `cur` becomes the new `prev` and the old `prev` buffer is reused.
    const spent = prev ?? new Uint8Array(area);
    prev = cur;
    cur = spent;
  }

  out.byte(0x3b); // trailer
  return out.bytes();
}

/* --------------------------------------------------------------------- frame diffing ----- */

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Bounding box of every index that differs from the previous frame, or null when nothing does.
 *
 * Diffed on PALETTE INDICES, not on source RGB. That is the stricter test of the two and the
 * only one that is safe: two source pixels that differ imperceptibly may quantise to the same
 * index (no need to redraw), and — the case that actually bites — an ordered-dithered pixel is
 * only stable frame to frame because its dither offset depends on position alone. Diffing the
 * post-dither indices is what proves that stability instead of assuming it.
 */
function changedRect(
  prev: Uint8Array,
  cur: Uint8Array,
  width: number,
  height: number,
): Rect | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let rowMin = -1;
    let rowMax = -1;
    for (let x = 0; x < width; x += 1) {
      if (prev[row + x] !== cur[row + x]) {
        if (rowMin < 0) rowMin = x;
        rowMax = x;
      }
    }
    if (rowMin < 0) continue;
    if (y < minY) minY = y;
    maxY = y;
    if (rowMin < minX) minX = rowMin;
    if (rowMax > maxX) maxX = rowMax;
  }

  if (maxY < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Copy the rectangle out of the frame, replacing pixels that did not change with the
 * transparent index. Returns whether any such pixel exists.
 *
 * The bounding box of a diagonal band is mostly unchanged pixels; blanking them turns those
 * runs into a single repeated index, which is the case LZW compresses best. When the box
 * happens to be entirely dirty the transparency flag is left off — one less thing for an old
 * mail client to get wrong, at no cost.
 */
function extractRect(
  cur: Uint8Array,
  prev: Uint8Array | null,
  rect: Rect,
  width: number,
  transparentIndex: number,
  out: Uint8Array,
): boolean {
  let anyTransparent = false;
  let o = 0;
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    const row = y * width;
    for (let x = rect.x; x < rect.x + rect.w; x += 1, o += 1) {
      const i = row + x;
      if (prev !== null && prev[i] === cur[i]) {
        out[o] = transparentIndex;
        anyTransparent = true;
      } else {
        out[o] = cur[i];
      }
    }
  }
  return anyTransparent;
}

/* ----------------------------------------------------------------------- block writers --- */

function writeLogicalScreenDescriptor(
  out: ByteStream,
  width: number,
  height: number,
  tableSize: number,
  palette: Palette,
): void {
  out.u16(width);
  out.u16(height);
  const globalColorTableFlag = 1;
  const colorResolution = 8; // bits per channel in the SOURCE, not in the table
  const sortFlag = 0;
  out.byte(
    (globalColorTableFlag << 7) |
      ((colorResolution - 1) << 4) |
      (sortFlag << 3) |
      (Math.log2(tableSize) - 1),
  );
  // Background index. Pointing it at white matters for the rare client that paints the canvas
  // background before the first frame: the signature must never flash a dark rectangle.
  out.byte(palette.whiteIndex >= 0 ? palette.whiteIndex : 0);
  out.byte(0); // pixel aspect ratio: none
}

function writeColorTable(out: ByteStream, palette: Palette, tableSize: number): void {
  for (let i = 0; i < tableSize; i += 1) {
    if (i < palette.size) {
      out.byte(palette.rgb[3 * i]);
      out.byte(palette.rgb[3 * i + 1]);
      out.byte(palette.rgb[3 * i + 2]);
    } else {
      out.byte(0);
      out.byte(0);
      out.byte(0);
    }
  }
}

function writeNetscapeLoop(out: ByteStream, repeat: number): void {
  out.byte(0x21);
  out.byte(0xff);
  out.byte(11);
  out.ascii("NETSCAPE2.0");
  out.byte(3);
  out.byte(1);
  out.u16(repeat); // 0 = forever
  out.byte(0);
}

/** Per-encode state shared by every frame. */
interface FrameContext {
  transparentIndex: number;
  delayCs: number;
  codeSize: number;
  accum: Uint8Array;
  htab: Int32Array;
  codetab: Int32Array;
}

function writeFrame(
  out: ByteStream,
  rect: Rect,
  pixels: Uint8Array,
  transparent: boolean,
  ctx: FrameContext,
): void {
  // Graphic control extension.
  out.byte(0x21);
  out.byte(0xf9);
  out.byte(4);
  out.byte(((DISPOSE_LEAVE & 7) << 2) | (transparent ? 1 : 0));
  out.u16(ctx.delayCs);
  out.byte(transparent ? ctx.transparentIndex : 0);
  out.byte(0);

  // Image descriptor — the four numbers gifenc cannot express.
  out.byte(0x2c);
  out.u16(rect.x);
  out.u16(rect.y);
  out.u16(rect.w);
  out.u16(rect.h);
  out.byte(0); // no local colour table, not interlaced

  lzwEncode(pixels, ctx.codeSize, out, ctx.accum, ctx.htab, ctx.codetab);
}

/* ---------------------------------------------------------------------------- helpers ---- */

/** Smallest power-of-two colour table that holds `n` entries. GIF allows 2..256. */
function colorTableSize(n: number): number {
  const bits = Math.max(1, Math.ceil(Math.log2(Math.max(2, n))));
  if (bits > 8) throw new RangeError(`colour table of ${n} entries exceeds GIF's 256`);
  return 1 << bits;
}

function assertU16(name: string, v: number, min: number): void {
  if (!Number.isInteger(v) || v < min || v > 0xffff) {
    throw new RangeError(`${name} must be an integer in ${min}..65535, got ${v}`);
  }
}

class ByteStream {
  private buf: Uint8Array;
  private len = 0;

  constructor(capacity: number) {
    this.buf = new Uint8Array(capacity);
  }

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length || 1;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  byte(v: number): void {
    this.ensure(1);
    this.buf[this.len++] = v;
  }

  u16(v: number): void {
    this.ensure(2);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >> 8) & 0xff;
  }

  ascii(s: string): void {
    this.ensure(s.length);
    for (let i = 0; i < s.length; i += 1) this.buf[this.len++] = s.charCodeAt(i) & 0xff;
  }

  copy(src: Uint8Array, offset: number, length: number): void {
    this.ensure(length);
    this.buf.set(src.subarray(offset, offset + length), this.len);
    this.len += length;
  }

  bytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/* ------------------------------------------------------------------------------ LZW ------ */
/*
  Adapted from gifenc/src/lzwEncode.js — MIT (c) 2017 Matt DesLauriers.
  Original lineage: Kevin Weiner (Java) / Thibault Imbert (AS3) / Johan Nordberg (JS), from
  GIFCOMPR.C by David Rowley, from compress.c (Thomas, McKie, Davies, Turkowski, Woods, Orost).
  V8 optimisations by Matt DesLauriers and Mathieu Henri (@p01).
*/

const LZW_BITS = 12;
const LZW_HSIZE = 5003; // 80% occupancy
const LZW_MASKS = [
  0x0000, 0x0001, 0x0003, 0x0007, 0x000f, 0x001f, 0x003f, 0x007f, 0x00ff, 0x01ff, 0x03ff, 0x07ff,
  0x0fff, 0x1fff, 0x3fff, 0x7fff, 0xffff,
];

function lzwEncode(
  pixels: Uint8Array,
  colorDepth: number,
  outStream: ByteStream,
  accum: Uint8Array,
  htab: Int32Array,
  codetab: Int32Array,
): void {
  const hsize = htab.length;
  const initCodeSize = Math.max(2, colorDepth);

  accum.fill(0);
  codetab.fill(0);
  htab.fill(-1);

  let cur_accum = 0;
  let cur_bits = 0;

  const g_init_bits = initCodeSize + 1;

  let clear_flg = false;
  let n_bits = g_init_bits;
  let maxcode = (1 << n_bits) - 1;

  const ClearCode = 1 << (g_init_bits - 1);
  const EOFCode = ClearCode + 1;
  let free_ent = ClearCode + 2;
  let a_count = 0;

  let ent = pixels[0];

  let hshift = 0;
  for (let fcode = hsize; fcode < 65536; fcode *= 2) ++hshift;
  hshift = 8 - hshift; // set hash code range bound

  outStream.byte(initCodeSize);
  output(ClearCode);

  const length = pixels.length;
  for (let idx = 1; idx < length; idx += 1) {
    next_block: {
      const c = pixels[idx];
      const fcode = (c << LZW_BITS) + ent;
      let i = (c << hshift) ^ ent; // xor hashing
      if (htab[i] === fcode) {
        ent = codetab[i];
        break next_block;
      }

      const disp = i === 0 ? 1 : hsize - i; // secondary hash (after G. Knott)
      while (htab[i] >= 0) {
        i -= disp;
        if (i < 0) i += hsize;
        if (htab[i] === fcode) {
          ent = codetab[i];
          break next_block;
        }
      }
      output(ent);
      ent = c;
      if (free_ent < 1 << LZW_BITS) {
        codetab[i] = free_ent++;
        htab[i] = fcode;
      } else {
        htab.fill(-1);
        free_ent = ClearCode + 2;
        clear_flg = true;
        output(ClearCode);
      }
    }
  }

  output(ent);
  output(EOFCode);
  outStream.byte(0); // block terminator

  function flushAccum(): void {
    if (a_count > 0) {
      outStream.byte(a_count);
      outStream.copy(accum, 0, a_count);
      a_count = 0;
    }
  }

  function output(code: number): void {
    cur_accum &= LZW_MASKS[cur_bits];

    if (cur_bits > 0) cur_accum |= code << cur_bits;
    else cur_accum = code;

    cur_bits += n_bits;

    while (cur_bits >= 8) {
      accum[a_count++] = cur_accum & 0xff;
      if (a_count >= 254) flushAccum();
      cur_accum >>= 8;
      cur_bits -= 8;
    }

    if (free_ent > maxcode || clear_flg) {
      if (clear_flg) {
        n_bits = g_init_bits;
        maxcode = (1 << n_bits) - 1;
        clear_flg = false;
      } else {
        ++n_bits;
        maxcode = n_bits === LZW_BITS ? 1 << n_bits : (1 << n_bits) - 1;
      }
    }

    if (code === EOFCode) {
      while (cur_bits > 0) {
        accum[a_count++] = cur_accum & 0xff;
        if (a_count >= 254) flushAccum();
        cur_accum >>= 8;
        cur_bits -= 8;
      }
      flushAccum();
    }
  }
}
