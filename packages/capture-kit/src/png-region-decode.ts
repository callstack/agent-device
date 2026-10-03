import zlib from 'node:zlib';
import type { Rect } from '@agent-device/kernel/snapshot';
import {
  type PngHeader,
  pngTruecolorChannels,
  readPngChunks,
  readPngHeader,
} from './png-format.ts';
import {
  addByte,
  PNG_ROW_FILTERS,
  predictByte,
  PREDICT_NONE,
  PREDICT_PAETH,
  PREDICT_SUB,
  PREDICT_UP,
} from './png-predictor.ts';

/**
 * Reads one rectangular region out of a PNG file without materializing the image's pixels.
 *
 * The reader claims 8-bit non-interlaced truecolor (RGB and RGBA) — the layout every supported
 * device screenshot backend emits. A deflate stream cannot be cut short: this inflates the
 * complete image into a buffer as large as the whole image's filtered rows, and reconstructs every
 * row above the region, because a row filter can depend on the row above it. What stops at the
 * region is the pixel work — reconstruction ends at the region's last row, and the pixels allocated
 * and copied are the region's alone. Anything it does not claim returns `null`, which sends the
 * caller to the general PNG reader; that reader owns the canonical decode error, so a decline here
 * never becomes a worse diagnosis there.
 *
 * `box` is expected to lie inside the header's image; the caller checks that first, because an
 * oversized box is a caller error rather than a layout this reader declines.
 */

const COMPRESSION_DEFLATE = 0;
const FILTER_METHOD_ADAPTIVE = 0;
const BIT_DEPTH_8 = 8;
const NOT_INTERLACED = 0;
const OPAQUE_ALPHA = 255;

export type PngDecodedRegion = Readonly<{
  width: number;
  height: number;
  channels: 3 | 4;
  pixels: Uint8Array;
}>;

/** The IHDR of a PNG this reader can produce region pixels for, or `null` when it cannot. */
export function readPngRegionHeader(bytes: Uint8Array): PngHeader | null {
  const header = readPngHeader(bytes);
  if (
    header === null ||
    header.bitDepth !== BIT_DEPTH_8 ||
    header.compressionMethod !== COMPRESSION_DEFLATE ||
    header.filterMethod !== FILTER_METHOD_ADAPTIVE ||
    header.interlace !== NOT_INTERLACED ||
    pngTruecolorChannels(header.colorType) === null
  ) {
    return null;
  }
  return header;
}

export function decodePngRegion(
  source: Uint8Array,
  header: PngHeader,
  box: Rect,
): PngDecodedRegion | null {
  const channels = pngTruecolorChannels(header.colorType);
  if (channels === null) return null;
  const imageStream = readImageStream(source);
  if (imageStream === null) return null;

  const stride = header.width * channels;
  const scanlineBytes = header.height * (stride + 1);
  const scanlines = inflateScanlines(imageStream, scanlineBytes);
  if (scanlines === null || scanlines.length < scanlineBytes) return null;

  for (let row = 0; row < box.y + box.height; row += 1) {
    if (!unfilterScanline(scanlines, row, stride, channels)) return null;
  }
  if (!hasReadableFiltersBelow(scanlines, box.y + box.height, header.height, stride)) return null;

  // An RGB source has no alpha to carry. An RGBA source keeps it only when a pixel in the
  // region actually needs it; otherwise the output pays for a channel nobody reads.
  const outChannels: 3 | 4 = channels === 4 && !isRegionOpaque(scanlines, box, stride) ? 4 : 3;
  return {
    width: box.width,
    height: box.height,
    channels: outChannels,
    pixels: copyRegionRows(scanlines, box, stride, channels, outChannels),
  };
}

/**
 * Reconstructs one scanline in place. `false` reports a filter type this reader does not
 * implement, which declines the whole region rather than guessing at pixels.
 */
function unfilterScanline(
  scanlines: Uint8Array,
  row: number,
  stride: number,
  channels: number,
): boolean {
  const data = row * (stride + 1) + 1;
  const filter = scanlines[data - 1]!;
  if (!PNG_ROW_FILTERS.includes(filter)) return false;
  if (filter === PREDICT_NONE) return true;
  // Row zero has no row above it, so every neighbour that reads upward is zero: `Up` adds
  // nothing, and `Paeth` collapses to `Sub` because the left byte wins the tie.
  if (row === 0) return unfilterFirstRow(scanlines, data, stride, channels, filter);
  return unfilterRow(scanlines, data, stride, channels, filter);
}

function unfilterFirstRow(
  scanlines: Uint8Array,
  data: number,
  stride: number,
  channels: number,
  filter: number,
): boolean {
  const end = data + stride;
  if (filter === PREDICT_SUB || filter === PREDICT_PAETH) {
    for (let at = data + channels; at < end; at += 1) {
      scanlines[at] = addByte(scanlines[at]!, scanlines[at - channels]!);
    }
    return true;
  }
  for (let at = data; at < end; at += 1) {
    const left = at >= data + channels ? scanlines[at - channels]! : 0;
    scanlines[at] = addByte(scanlines[at]!, predictByte(filter, left, 0, 0));
  }
  return true;
}

function unfilterRow(
  scanlines: Uint8Array,
  data: number,
  stride: number,
  channels: number,
  filter: number,
): boolean {
  const end = data + stride;
  const above = data - (stride + 1);
  if (filter === PREDICT_SUB) {
    for (let at = data + channels; at < end; at += 1) {
      scanlines[at] = addByte(scanlines[at]!, scanlines[at - channels]!);
    }
    return true;
  }
  if (filter === PREDICT_UP) {
    for (let at = data; at < end; at += 1) {
      scanlines[at] = addByte(scanlines[at]!, scanlines[above + (at - data)]!);
    }
    return true;
  }
  for (let at = data; at < end; at += 1) {
    const offset = at - data;
    const left = at >= data + channels ? scanlines[at - channels]! : 0;
    scanlines[at] = addByte(
      scanlines[at]!,
      predictByte(
        filter,
        left,
        scanlines[above + offset]!,
        at >= data + channels ? scanlines[above + offset - channels]! : 0,
      ),
    );
  }
  return true;
}

/**
 * Rows below the region are never reconstructed, so their filter bytes are read instead of applied.
 * A filter this reader does not implement disqualifies a file wherever it sits, and the general
 * reader is the one that says so.
 */
function hasReadableFiltersBelow(
  scanlines: Uint8Array,
  firstRow: number,
  imageHeight: number,
  stride: number,
): boolean {
  for (let row = firstRow; row < imageHeight; row += 1) {
    if (!PNG_ROW_FILTERS.includes(scanlines[row * (stride + 1)]!)) return false;
  }
  return true;
}

/** True when every pixel of the region is fully opaque, so the output can drop its alpha. */
function isRegionOpaque(scanlines: Uint8Array, box: Rect, stride: number): boolean {
  let alphaAnd = OPAQUE_ALPHA;
  for (let row = box.y; row < box.y + box.height && alphaAnd === OPAQUE_ALPHA; row += 1) {
    // Row layout is [filter byte][pixel bytes], and this runs only for a 4-channel source,
    // so the first alpha sits one byte past the filter byte plus three into the first pixel.
    const firstAlpha = row * (stride + 1) + 4;
    for (let column = 0; column < box.width; column += 1) {
      alphaAnd &= scanlines[firstAlpha + (box.x + column) * 4]!;
    }
  }
  return alphaAnd === OPAQUE_ALPHA;
}

function copyRegionRows(
  scanlines: Uint8Array,
  box: Rect,
  stride: number,
  channels: number,
  outChannels: number,
): Uint8Array {
  const outStride = box.width * outChannels;
  const pixels = new Uint8Array(box.height * outStride);
  for (let row = 0; row < box.height; row += 1) {
    const data = (row + box.y) * (stride + 1) + 1 + box.x * channels;
    const offset = row * outStride;
    if (channels === outChannels) {
      pixels.set(scanlines.subarray(data, data + box.width * channels), offset);
    } else {
      for (let column = 0; column < box.width; column += 1) {
        const from = data + column * channels;
        const to = offset + column * outChannels;
        pixels[to] = scanlines[from]!;
        pixels[to + 1] = scanlines[from + 1]!;
        pixels[to + 2] = scanlines[from + 2]!;
      }
    }
  }
  return pixels;
}

function inflateScanlines(imageStream: Uint8Array, scanlineBytes: number): Uint8Array | null {
  try {
    return zlib.inflateSync(imageStream, { maxOutputLength: scanlineBytes });
  } catch {
    return null;
  }
}

/** The concatenated image data, or `null` when a chunk this reader will not interpret appears. */
function readImageStream(bytes: Uint8Array): Uint8Array | null {
  const chunks = readPngChunks(bytes);
  if (chunks === null) return null;
  const imageStreams: Uint8Array[] = [];
  for (const chunk of chunks) {
    // A palette or a single transparent color needs interpretation before its pixels mean
    // anything, which is the general reader's job.
    if (chunk.type === 'PLTE' || chunk.type === 'tRNS') return null;
    if (chunk.type === 'IDAT') imageStreams.push(chunk.data);
  }
  return imageStreams.length === 0 ? null : Buffer.concat(imageStreams);
}
