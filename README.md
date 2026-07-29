# Signature Studio

Make an animated e-mail signature in your browser. Upload a photo, place two points on your
face, type your details, get a looping black-and-white signature you can paste into Gmail or
Outlook. No account, no installation, and your original photo never leaves your device.

It is a port of a signature built by hand in `jonathan-naal/videos` with Remotion and ffmpeg.
That version worked for exactly one face; this one has to work for anyone's.

## Status

Early. The geometry solver is done and tested; nothing renders yet.

| | |
|---|---|
| ✅ | `lib/geometry.ts` — face landmarks → crop + band geometry, 38 tests green |
| ⬜ | `lib/grade.ts` — crop, greyscale and contrast in the browser |
| ⬜ | `lib/render.ts` — the shutter and the typewriter on canvas |
| ⬜ | `lib/gif/` — GIF muxer with sub-rectangle frames |
| ⬜ | the studio UI, hosting, the AI assist |

## The one idea worth knowing

The animation cuts the portrait into five leaning bands that rest at alternating heights. The
bands are a **mask, not a collage**: the photograph is drawn once and never moved, and only
each band's window slides over it. That is what keeps the face continuous — and it is also
what makes the file small, because the photo's pixels do not change between frames. (In the
hand-built version, switching to this model took the portrait from 415 KB to 70 KB.)

The consequence is a constraint. High and low windows only overlap over part of the height,
and **the face has to sit inside that overlap** — anywhere else, a band edge slices across it.

In the hand-built version the geometry was fixed and the crop was tuned until the face fitted.
That took four attempts on one face, with the ability to look at every render. A stranger
cannot do that, so `lib/geometry.ts` inverts the dependency: **you say where your face is, and
the geometry is solved from it.**

You declare two points — the **eye line** and the **chin**. Not "the top of your head", which
is genuinely ambiguous (crown? hairline? the hat?) and where a 50px error decapitates the
portrait while every internal check still passes.

### Why it collapses to one number

The validated reference has `WINDOW_H = 212`, `REST = 24`, `PHOTO_H = 260` — that is,
`WINDOW_H + 2·REST = PHOTO_H` exactly. The windows tile the photo: the high one starts flush
with the top, the low one ends flush with the bottom. So `WINDOW_H` is derived, `REST` is the
only free parameter, and the overlap is just `[2·REST, PHOTO_H − 2·REST]`.

Solving `REST` is then one line — take the deepest staircase that still clears the face:

```
REST = ⌊ min( (hairline − margin) / 2 , (PHOTO_H − chin − margin) / 2 ) ⌋
```

On the reference photo that returns **exactly 24**, and lands the hairline **exactly 8px**
below the low window's edge — the rule that was arrived at by eye, now falling out of the
arithmetic. `test/geometry.test.ts` asserts it.

### When a photo cannot be used

The ideal framing often wants pixels the photo does not have. Up to 15% of the crop may hang
off the edge and is filled with white, which is benign because the composition already floats
on white. Past that the solver returns `ok: false` and the app asks for another photo — some
photographs genuinely lack the headroom, and rendering a sliced face while reporting success
is not an option.

Measured envelope: a typical square LinkedIn portrait and an arm's-length selfie both pass. A
face filling half the frame, or a head starting 6% from the top, are refused.

## Constraints that shape everything

Not preferences — they are what e-mail actually does.

- **GIF or nothing.** Every mail client strips `<video>`, `<style>` and CSS animation.
- **Frame 0 must be the resting state.** Outlook 2016/2019 and Outlook for Mac show only the
  first frame. (Classic Outlook on Microsoft 365 or Office 2021 *does* animate — the common
  claim that it never does is out of date.)
- **25 fps, exactly.** GIF frame delays are integer centiseconds; 24 or 30 fps get rounded by
  the client and the loop judders.
- **No grain.** It changes every pixel on every frame and defeats inter-frame compression.
- **Absolute image URLs, never base64.** Gmail caps a signature at ~10 000 characters; a 70 KB
  GIF is ~93 000 characters of base64.
- **You finish on a computer.** The Gmail and Outlook mobile signature editors are plain text.
  Nobody can install a rich signature from a phone, with any tool.

## Develop

```bash
npm install
npm test          # geometry suite
npm run dev
```

Test fixtures in `test/fixtures/` are the reference renders from the hand-built version; they
are the regression target for the browser port.
