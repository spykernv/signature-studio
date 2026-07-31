import { put } from "@vercel/blob";

/**
 * Publishes a finished signature's GIFs and hands back their public addresses.
 *
 * WHY THIS EXISTS AT ALL. A mail signature can only LINK to images, never carry them: Gmail's
 * signature field caps near 10 000 characters and a 45 KB signature would be ~60 000 characters
 * of base64. Without somewhere public to put them, the honest flow is "download these two
 * files, host them yourself, paste the addresses back" — five steps and a concept most people
 * do not have. This route is what turns that into one button.
 *
 * WHAT IT ACCEPTS, AND WHY SO LITTLE. There are no accounts here, so this is an open write
 * endpoint on somebody else's storage bill. The defence is not authentication but SHAPE: the
 * only thing that gets stored is a file that is already, verifiably, one of our own GIFs.
 * Anything else is refused before it reaches the store.
 */

export const runtime = "nodejs";

/** Comfortably above a real signature (~55 KB) and far below anything worth abusing. */
const MAX_PORTRAIT = 400 * 1024;
const MAX_WORDMARK = 120 * 1024;

/** What the studio produces. A file claiming other dimensions did not come from here. */
const PORTRAIT_SIZE = { w: 224, h: 276 };
const WORDMARK_SIZE = { w: 360, h: 56 };

interface GifHeader {
  width: number;
  height: number;
}

/**
 * Reads a GIF's logical screen descriptor, and refuses anything that is not one.
 *
 * Checking the magic bytes alone would let a 400 KB file through with `GIF89a` glued to the
 * front, which is the oldest trick there is for turning a validating uploader into free
 * hosting. Parsing the descriptor and insisting on OUR dimensions is what makes that pointless:
 * the endpoint will only ever store a 224x276 or 360x56 greyscale loop.
 */
function readGif(bytes: Uint8Array): GifHeader | null {
  if (bytes.length < 13) return null;
  const sig = String.fromCharCode(...bytes.subarray(0, 6));
  if (sig !== "GIF89a" && sig !== "GIF87a") return null;
  return {
    width: bytes[6] | (bytes[7] << 8),
    height: bytes[8] | (bytes[9] << 8),
  };
}

function reject(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

export async function POST(req: Request) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    // A missing token is a deployment fault, not a user's. Say so plainly rather than letting
    // the SDK throw something that reads like the user's file was wrong.
    return reject("Publishing is not configured on this deployment.", 503);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return reject("Expected multipart form data.");
  }

  const portrait = form.get("portrait");
  const wordmark = form.get("wordmark");

  if (!(portrait instanceof Blob)) return reject("Missing the portrait GIF.");
  if (portrait.size > MAX_PORTRAIT) return reject("The portrait GIF is larger than expected.");
  if (wordmark instanceof Blob && wordmark.size > MAX_WORDMARK) {
    return reject("The wordmark GIF is larger than expected.");
  }

  const portraitBytes = new Uint8Array(await portrait.arrayBuffer());
  const portraitHeader = readGif(portraitBytes);
  if (
    portraitHeader === null ||
    portraitHeader.width !== PORTRAIT_SIZE.w ||
    portraitHeader.height !== PORTRAIT_SIZE.h
  ) {
    return reject("That is not a signature portrait produced by this studio.");
  }

  let wordmarkBytes: Uint8Array | null = null;
  if (wordmark instanceof Blob) {
    wordmarkBytes = new Uint8Array(await wordmark.arrayBuffer());
    const h = readGif(wordmarkBytes);
    if (h === null || h.width !== WORDMARK_SIZE.w || h.height !== WORDMARK_SIZE.h) {
      return reject("That is not a signature wordmark produced by this studio.");
    }
  }

  try {
    // `addRandomSuffix` is doing real work: without it two people called Jean would collide,
    // and the second upload would silently replace the first person's live signature.
    // The original Blob, not the Uint8Array copy made for validation: `put` takes a Blob
    // directly, and re-wrapping would duplicate 55 KB for nothing.
    const portraitBlob = await put("signature/portrait.gif", portrait, {
      access: "public",
      contentType: "image/gif",
      addRandomSuffix: true,
      // Immutable by URL. The address changes whenever the picture does, which is the only
      // model that works here: Gmail's image proxy ignores cache headers and publishes no
      // expiry, so replacing a file in place is not something we could offer honestly.
      cacheControlMaxAge: 31_536_000,
    });

    const wordmarkBlob =
      wordmark instanceof Blob && wordmarkBytes !== null
        ? await put("signature/name.gif", wordmark, {
          access: "public",
          contentType: "image/gif",
          addRandomSuffix: true,
          cacheControlMaxAge: 31_536_000,
        })
      : null;

    return Response.json({
      portraitUrl: portraitBlob.url,
      wordmarkUrl: wordmarkBlob?.url ?? null,
    });
  } catch (err) {
    return reject(
      err instanceof Error ? `Could not publish: ${err.message}` : "Could not publish.",
      502,
    );
  }
}
