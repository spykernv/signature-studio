/**
 * Turning an uploaded file into the one working image the rest of the studio uses.
 *
 * ONE WORKING RESOLUTION. The upload is downsampled to a fixed long edge before anything else
 * touches it, and every later stage — the on-screen photo, `solve()`, the live preview, the
 * final render — reads those same pixels. It removes a whole class of bug where the preview and
 * the output disagree because they were graded from different source images.
 *
 * The edge is 1620 because that is the height of the reference portrait
 * (`test/fixtures/source-portrait.png`, 1080x1620), whose crop was 945px tall and was graded
 * down to 260. Staying at that ratio keeps `lib/grade.ts` inside the regime it was validated
 * in, and 1620 is still six times the output height — nothing visible is being thrown away.
 *
 * It also caps memory. A 25 MB phone photo decodes to over 200 MB of RGBA; holding that for a
 * session, twice (bitmap and pixels), is how a tab gets killed on a laptop.
 */

/** Refused before decoding: the browser will happily try to decode a 200 MB file and die. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export const MAX_WORK_EDGE = 1620;

export interface Photo {
  /** The working pixels. This is what `solve()` is given and what the worker grades. */
  work: ImageData;
  /** The same pixels as a bitmap, for painting the positioner. */
  bitmap: ImageBitmap;
  width: number;
  height: number;
  /** For the "photo.jpg, 3.4 MB" line under the upload. */
  fileName: string;
  fileBytes: number;
}

export type PhotoErrorKind = "too-big" | "heic" | "undecodable" | "unsupported-browser";

export class PhotoError extends Error {
  constructor(
    readonly kind: PhotoErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "PhotoError";
  }
}

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * Is this an HEIC/HEIF file?
 *
 * Sniffed from the ISO-BMFF header rather than trusted from `file.type`, because the type an
 * iPhone photo arrives with depends on how it got here: AirDrop gives `image/heic`, a file
 * picked out of a synced folder often gives `""` or `application/octet-stream`, and a file
 * renamed to .jpg gives `image/jpeg`. The brand box is the only reliable answer, and the whole
 * point of this check is to replace a generic "could not read that image" with the one sentence
 * that actually helps.
 *
 * Layout: bytes 4..8 are `ftyp`, bytes 8..12 are the major brand. The HEIF brands are `heic`,
 * `heix`, `hevc`, `hevx`, `mif1` and `msf1`.
 */
async function looksLikeHeic(file: File): Promise<boolean> {
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (head.length < 12) return false;
    const ascii = (from: number, to: number) =>
      String.fromCharCode(...head.subarray(from, to)).toLowerCase();
    if (ascii(4, 8) !== "ftyp") return false;
    return ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(ascii(8, 12));
  } catch {
    return false;
  }
}

const HEIC_MESSAGE =
  "iPhone photos in HEIC need converting — screenshot it or export as JPEG.";

/**
 * Decode, downsample, and hand back both representations.
 *
 * `imageOrientation: "from-image"` is not optional: without it, a photo shot in portrait on a
 * phone arrives with its EXIF rotation unapplied, so the face is on its side and the user is
 * asked to place a chin that is horizontal.
 */
export async function loadPhoto(file: File): Promise<Photo> {
  if (file.size > MAX_FILE_BYTES) {
    throw new PhotoError(
      "too-big",
      `That file is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_FILE_BYTES)} — a photo that large has far more detail than a 208-pixel-wide portrait can use.`,
    );
  }

  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") {
    throw new PhotoError(
      "unsupported-browser",
      "This browser is missing the image APIs the studio needs. Try a current Chrome, Edge, Firefox or Safari.",
    );
  }

  let decoded: ImageBitmap;
  try {
    decoded = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    if (await looksLikeHeic(file)) throw new PhotoError("heic", HEIC_MESSAGE);
    throw new PhotoError(
      "undecodable",
      "That file could not be read as an image. JPEG, PNG and WebP all work.",
    );
  }

  try {
    const scale = Math.min(1, MAX_WORK_EDGE / Math.max(decoded.width, decoded.height));
    const w = Math.max(1, Math.round(decoded.width * scale));
    const h = Math.max(1, Math.round(decoded.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new PhotoError("unsupported-browser", "This browser refused a 2D canvas.");

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(decoded, 0, 0, w, h);
    const work = ctx.getImageData(0, 0, w, h);

    return {
      work,
      // Built from the working pixels, not from `decoded`, so what the user drags guides across
      // is exactly what the solver measures.
      bitmap: await createImageBitmap(work),
      width: w,
      height: h,
      fileName: file.name || "photo",
      fileBytes: file.size,
    };
  } finally {
    // Frees the full-resolution decode immediately rather than at the next GC, which on a large
    // phone photo is a hundred megabytes or more.
    decoded.close();
  }
}
