import { test } from 'vitest';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { encodePngPixels } from './png-encode.ts';
import { decodePngRegion, readPngRegionHeader } from './png-region-decode.ts';
import { corruptChunkChecksum, rampPixels, readPngForTest } from './png-codec.fixtures.ts';

const WIDTH = 5;
const HEIGHT = 3;
const FULL_BOX = { x: 0, y: 0, width: WIDTH, height: HEIGHT };

test('RGB pixels round-trip through a decoder as truecolor', () => {
  const pixels = rampPixels(WIDTH, HEIGHT, 3);

  const encoded = encodePngPixels(pixels, WIDTH, HEIGHT, 3);

  const decoded = readPngForTest(encoded);
  assert.equal(decoded.colorType, 2);
  assert.equal(decoded.bitDepth, 8);
  assert.deepEqual([decoded.width, decoded.height], [WIDTH, HEIGHT]);
  assertSameChannelOrder(decoded.rgba, pixels, 3, 4);
});

test('RGBA pixels round-trip through a decoder keeping their alpha', () => {
  const pixels = rampPixels(WIDTH, HEIGHT, 4, (x) => (x % 2 === 0 ? 128 : 255));

  const encoded = encodePngPixels(pixels, WIDTH, HEIGHT, 4);

  const decoded = readPngForTest(encoded);
  assert.equal(decoded.colorType, 6);
  assertSameChannelOrder(decoded.rgba, pixels, 4, 4);
});

test('every written scanline declares the None filter', () => {
  const encoded = encodePngPixels(rampPixels(WIDTH, HEIGHT, 3), WIDTH, HEIGHT, 3);

  assert.deepEqual(scanlineFilters(encoded), [0, 0, 0]);
});

test('the encoding is readable by the region reader, so its checksums are real', () => {
  const pixels = rampPixels(WIDTH, HEIGHT, 3);
  const encoded = encodePngPixels(pixels, WIDTH, HEIGHT, 3);

  const header = readPngRegionHeader(encoded);
  assert.notEqual(header, null);
  const region = decodePngRegion(encoded, header!, FULL_BOX);
  assert.notEqual(region, null);
  assertSameChannelOrder(region!.pixels, pixels, 3, 3);

  const corrupted = corruptChunkChecksum(encoded, 'IDAT');
  assert.equal(decodePngRegion(corrupted, readPngRegionHeader(corrupted)!, FULL_BOX), null);
});

function scanlineFilters(buffer: Buffer): number[] {
  const stride = WIDTH * 3;
  const scanlines = zlib.inflateSync(idatOf(buffer));
  return Array.from({ length: HEIGHT }, (_unused, row) => scanlines[row * (stride + 1)]!);
}

function idatOf(buffer: Buffer): Buffer {
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (buffer.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      return Buffer.from(buffer.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }
  throw new Error('encoded PNG carries no image data');
}

/** `pngjs` always hands back RGBA, so the comparison walks the channels that were written. */
function assertSameChannelOrder(
  readBack: Uint8Array,
  written: Uint8Array,
  channels: number,
  readBackChannels: number,
): void {
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      assert.equal(
        readBack[pixel * readBackChannels + channel]!,
        written[pixel * channels + channel]!,
        `pixel ${pixel} channel ${channel}`,
      );
    }
  }
}
