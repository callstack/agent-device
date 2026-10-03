import zlib from 'node:zlib';
import { predictByte } from './png-predictor.ts';
import { PNG } from './png.ts';

/**
 * Test-only PNG writer. `pngjs` picks one filter for a whole image and cannot express the
 * per-row mixtures, palettes, transparency, and header variations the crop paths have to
 * classify, so fixtures assemble the chunks directly. Every fixture is read back by `pngjs`
 * in the test that uses it, which is what proves this writer is honest.
 */

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FILTER_CYCLE: readonly number[] = [0, 1, 2, 3, 4];
const IHDR_COLOR_TYPE_BYTE = 25;
const IHDR_BIT_DEPTH_BYTE = 24;

export type PngFixture = Readonly<{
  pixels: Uint8Array;
  width: number;
  height: number;
  channels: number;
  colorType: number;
  bitDepth?: number;
  interlace?: number;
  compressionMethod?: number;
  filterMethod?: number;
  filterFor?: (row: number) => number;
  palette?: Uint8Array;
  transparency?: Uint8Array;
  ancillary?: Readonly<{ type: string; data: Uint8Array }>;
}>;

export function encodeFixturePng(fixture: PngFixture): Buffer {
  const { height, width } = fixture;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = fixture.bitDepth ?? 8;
  header[9] = fixture.colorType;
  header[10] = fixture.compressionMethod ?? 0;
  header[11] = fixture.filterMethod ?? 0;
  header[12] = fixture.interlace ?? 0;
  const chunks: Uint8Array[] = [SIGNATURE, pngChunk('IHDR', header)];
  if (fixture.ancillary) chunks.push(pngChunk(fixture.ancillary.type, fixture.ancillary.data));
  if (fixture.palette) chunks.push(pngChunk('PLTE', fixture.palette));
  if (fixture.transparency) chunks.push(pngChunk('tRNS', fixture.transparency));
  chunks.push(pngChunk('IDAT', zlib.deflateSync(filterScanlines(fixture), { level: 6 })));
  chunks.push(pngChunk('IEND', new Uint8Array(0)));
  return Buffer.concat(chunks);
}

/** A pixel grid where neighbouring pixels differ, so a wrong row or column cannot hide. */
export function rampPixels(
  width: number,
  height: number,
  channels: number,
  alpha: (x: number, y: number) => number = () => 255,
): Uint8Array {
  const pixels = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      pixels[offset] = (x * 7 + y * 3) & 0xff;
      if (channels >= 3) {
        pixels[offset + 1] = (x * 11 + y * 5) & 0xff;
        pixels[offset + 2] = (x * 13 + y * 17) & 0xff;
      }
      if (channels === 2) pixels[offset + 1] = alpha(x, y) & 0xff;
      if (channels === 4) pixels[offset + 3] = alpha(x, y) & 0xff;
    }
  }
  return pixels;
}

/** Reads any encoded PNG back as RGBA through `pngjs`, with the layout bytes it declares. */
export function readPngForTest(buffer: Buffer): {
  width: number;
  height: number;
  colorType: number;
  bitDepth: number;
  rgba: Uint8Array;
} {
  const png = PNG.sync.read(buffer);
  return {
    width: png.width,
    height: png.height,
    colorType: buffer.readUInt8(IHDR_COLOR_TYPE_BYTE),
    bitDepth: buffer.readUInt8(IHDR_BIT_DEPTH_BYTE),
    rgba: png.data,
  };
}

function filterScanlines(fixture: PngFixture): Uint8Array {
  const { channels, height, width } = fixture;
  const stride = width * channels;
  const scanlines = new Uint8Array(height * (stride + 1));
  for (let row = 0; row < height; row += 1) {
    const data = row * (stride + 1) + 1;
    const filter = fixture.filterFor?.(row) ?? FILTER_CYCLE[row % FILTER_CYCLE.length]!;
    scanlines[row * (stride + 1)] = filter;
    const from = row * stride;
    for (let offset = 0; offset < stride; offset += 1) {
      scanlines[data + offset] =
        (fixture.pixels[from + offset]! -
          predictByte(
            filter,
            offset >= channels ? fixture.pixels[from + offset - channels]! : 0,
            row > 0 ? fixture.pixels[from - stride + offset]! : 0,
            row > 0 && offset >= channels ? fixture.pixels[from - stride + offset - channels]! : 0,
          )) &
        0xff;
    }
  }
  return scanlines;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'ascii');
  chunk.set(data, 8);
  chunk.writeUInt32BE(zlib.crc32(chunk.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
  return chunk;
}

/** Flips a byte of the named chunk's checksum, so a reader that verifies checksums must notice. */
export function corruptChunkChecksum(buffer: Buffer, type: string): Buffer {
  const corrupted = Buffer.from(buffer);
  let offset = 8;
  while (offset + 12 <= corrupted.length) {
    const length = corrupted.readUInt32BE(offset);
    if (corrupted.toString('ascii', offset + 4, offset + 8) === type) {
      const checksum = offset + 8 + length;
      corrupted[checksum] = (corrupted[checksum] ?? 0) ^ 0xff;
      return corrupted;
    }
    offset += 12 + length;
  }
  throw new Error(`fixture PNG carries no ${type} chunk to corrupt`);
}
