import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { Rect } from '@agent-device/kernel/snapshot';
import {
  decodePngRegion,
  readPngRegionHeader,
  type PngDecodedRegion,
} from './png-region-decode.ts';
import {
  corruptChunkChecksum,
  encodeFixturePng,
  rampPixels,
  type PngFixture,
} from './png-codec.fixtures.ts';

const FULL_ALPHA = 255;
const BOX: Rect = { x: 1, y: 1, width: 3, height: 2 };

test('the region reader returns the box pixels for each scanline filter', () => {
  for (let filter = 0; filter <= 4; filter += 1) {
    const pixels = rampPixels(5, 4, 3);
    const region = readRegion(
      encodeFixturePng({
        pixels,
        width: 5,
        height: 4,
        channels: 3,
        colorType: 2,
        filterFor: () => filter,
      }),
      BOX,
    );

    assert.deepEqual([region.width, region.height, region.channels], [3, 2, 3]);
    assertSamePixels(region, pixels, 5, 3, BOX, `filter ${filter}`);
  }
});

test('the first row reconstructs even though it has no row above it', () => {
  for (let filter = 0; filter <= 4; filter += 1) {
    const pixels = rampPixels(4, 3, 4, () => FULL_ALPHA);
    const firstRow: Rect = { x: 0, y: 0, width: 4, height: 1 };
    const region = readRegion(
      encodeFixturePng({
        pixels,
        width: 4,
        height: 3,
        channels: 4,
        colorType: 6,
        filterFor: () => filter,
      }),
      firstRow,
    );

    assertSamePixels(region, pixels, 4, 4, firstRow, `filter ${filter} of row 0`);
  }
});

test('an opaque region of an RGBA capture is returned without an alpha channel', () => {
  const buffer = encodeFixturePng({
    pixels: rampPixels(4, 3, 4, (x, y) => (x === 3 && y === 2 ? 10 : FULL_ALPHA)),
    width: 4,
    height: 3,
    channels: 4,
    colorType: 6,
  });

  assert.equal(readRegion(buffer, { x: 0, y: 0, width: 2, height: 2 }).channels, 3);
  assert.equal(readRegion(buffer, { x: 2, y: 1, width: 2, height: 2 }).channels, 4);
});

test('an unknown scanline filter is declined rather than guessed at', () => {
  assertStreamDecline(encodeFixturePng({ ...claimable(4, 3), filterFor: () => 9 }));
});

test('an unknown filter on a row below the region is declined too', () => {
  assertStreamDecline(
    encodeFixturePng({ ...claimable(4, 4), filterFor: (row) => (row === 3 ? 9 : 0) }),
  );
});

test('a file truncated inside its image data is declined', () => {
  const buffer = Buffer.from(encodeFixturePng(claimable(6, 5)));

  assertStreamDecline(buffer.subarray(0, buffer.length - 12));
});

test('a chunk whose checksum does not match is declined', () => {
  const buffer = corruptChunkChecksum(encodeFixturePng(claimable(4, 3)), 'IDAT');

  assertStreamDecline(buffer);
});

test('a transparency chunk is left to the general reader', () => {
  assertStreamDecline(
    encodeFixturePng({ ...claimable(4, 3), transparency: new Uint8Array([0, 0, 0, 128]) }),
  );
});

test('an unrelated ancillary chunk does not stop the region reader', () => {
  const image = claimable(5, 4);
  const buffer = encodeFixturePng({
    ...image,
    ancillary: { type: 'tEXt', data: new TextEncoder().encode('comment\0kept') },
  });

  assertSamePixels(readRegion(buffer, BOX), image.pixels, 5, 4, BOX, 'with a tEXt chunk');
});

test('a layout outside 8-bit non-interlaced truecolor is declined', () => {
  assertLayoutDecline({ ...claimable(4, 3), interlace: 1 });
  assertLayoutDecline({ ...claimable(4, 3), bitDepth: 16 });
  assertLayoutDecline({ ...claimable(4, 3), compressionMethod: 1 });
  assertLayoutDecline({ ...claimable(4, 3), filterMethod: 1 });
  assertLayoutDecline({ ...claimable(4, 3), colorType: 0, channels: 1 });
  assertLayoutDecline({ ...claimable(4, 3), colorType: 4, channels: 2 });
});

test('bytes that do not open with a readable IHDR are declined', () => {
  assert.equal(readPngRegionHeader(Buffer.alloc(0)), null);
  assert.equal(readPngRegionHeader(Buffer.from('not a png, and too short to be one')), null);
  assert.equal(readPngRegionHeader(withFirstChunkType(claimable(4, 3), 'tEXt')), null);
  assert.equal(
    readPngRegionHeader(corruptChunkChecksum(encodeFixturePng(claimable(4, 3)), 'IHDR')),
    null,
  );
});

function claimable(width: number, height: number): PngFixture {
  return {
    pixels: rampPixels(width, height, 4, () => FULL_ALPHA),
    width,
    height,
    channels: 4,
    colorType: 6,
  };
}

function withFirstChunkType(fixture: PngFixture, type: string): Buffer {
  const buffer = Buffer.from(encodeFixturePng(fixture));
  buffer.write(type, 12, 'ascii');
  return buffer;
}

function readRegion(buffer: Buffer, box: Rect) {
  const header = readPngRegionHeader(buffer);
  assert.notEqual(header, null, 'the layout should be claimable');
  const region = decodePngRegion(buffer, header!, box);
  assert.notEqual(region, null, 'the image stream should be readable');
  return region!;
}

function assertStreamDecline(buffer: Buffer, box: Rect = BOX): void {
  const header = readPngRegionHeader(buffer);
  assert.notEqual(header, null, 'the layout should be claimable');
  assert.equal(decodePngRegion(buffer, header!, box), null, 'the image stream should be declined');
}

function assertLayoutDecline(fixture: PngFixture): void {
  assert.equal(readPngRegionHeader(encodeFixturePng(fixture)), null);
}

/**
 * The reader keeps alpha only when the region needs it, so the comparison walks the channel
 * count it returned. Channel order is the same in both layouts, so index `c` matches itself.
 */
function assertSamePixels(
  region: PngDecodedRegion,
  expected: Uint8Array,
  sourceWidth: number,
  sourceChannels: number,
  box: Rect,
  message: string,
): void {
  const { channels } = region;
  for (let row = 0; row < box.height; row += 1) {
    for (let column = 0; column < box.width; column += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        assert.equal(
          region.pixels[(row * box.width + column) * channels + channel]!,
          expected[((row + box.y) * sourceWidth + column + box.x) * sourceChannels + channel]!,
          `${message}: pixel ${column},${row} channel ${channel}`,
        );
      }
    }
  }
}
