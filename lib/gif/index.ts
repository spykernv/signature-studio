/**
 * The GIF encoder's public surface.
 *
 * `encodeGif` is the whole product; everything else is exported because the palette is where
 * the visual decisions live and they have to be testable without a canvas.
 */

export { encodeGif, type GifOptions } from "./muxer";

export {
  buildPalette,
  createQuantizer,
  bayerOffsets,
  BAYER8,
  type Frame,
  type Palette,
  type DitherMode,
  type StatsMode,
  type BuildPaletteOptions,
} from "./palette";
