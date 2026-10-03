import { test } from 'vitest';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import type { Rect } from '@agent-device/kernel/snapshot';
import { cropPngBytes } from './png-crop-bytes.ts';
import {
  corruptChunkChecksum,
  encodeFixturePng,
  rampPixels,
  readPngForTest,
  type PngFixture,
} from './png-codec.fixtures.ts';

const OPAQUE = 255;
const LABEL = 'screenshot';
const PROPERTY_RUNS = 100;

test('a mixed-filter RGBA capture crops to the box pixels and drops its alpha channel', () => {
  const image = claimable(9, 6);
  const box: Rect = { x: 2, y: 1, width: 4, height: 3 };

  const cropped = cropPngBytes(encodeFixturePng(image), box, LABEL)!;

  assert.equal(readPngForTest(cropped).colorType, 2, 'an opaque crop keeps no alpha channel');
  assertCroppedPixels(cropped, image, box);
});

test('an RGB capture crops without gaining an alpha channel', () => {
  const image: PngFixture = {
    pixels: rampPixels(7, 5, 3),
    width: 7,
    height: 5,
    channels: 3,
    colorType: 2,
  };
  const box: Rect = { x: 1, y: 2, width: 3, height: 2 };

  const cropped = cropPngBytes(encodeFixturePng(image), box, LABEL)!;

  assert.equal(readPngForTest(cropped).colorType, 2);
  assertCroppedPixels(cropped, image, box);
});

test('a one-pixel crop of the last row and column reads the right pixel', () => {
  const image = claimable(6, 4);
  const box: Rect = { x: 5, y: 3, width: 1, height: 1 };

  assertCroppedPixels(cropPngBytes(encodeFixturePng(image), box, LABEL)!, image, box);
});

test('a box holding a translucent pixel keeps the alpha channel', () => {
  const image = translucentAt(8, 5, { x: 3, y: 2 });
  const box: Rect = { x: 2, y: 1, width: 4, height: 3 };

  const cropped = cropPngBytes(encodeFixturePng(image), box, LABEL)!;

  const decoded = readPngForTest(cropped);
  assert.equal(decoded.colorType, 6);
  assert.equal(decoded.rgba[(1 * box.width + 1) * 4 + 3], 128);
  assertCroppedPixels(cropped, image, box);
});

test('translucency outside the box still lets the crop drop alpha', () => {
  const image = translucentAt(8, 5, { x: 7, y: 4 });
  const box: Rect = { x: 0, y: 0, width: 4, height: 4 };

  const cropped = cropPngBytes(encodeFixturePng(image), box, LABEL)!;

  assert.equal(readPngForTest(cropped).colorType, 2);
  assertCroppedPixels(cropped, image, box);
});

test('a palette capture crops through the general reader with its colors intact', () => {
  const width = 6;
  const height = 5;
  const palette = new Uint8Array(3 * 4);
  for (let color = 0; color < 4; color += 1) {
    palette[color * 3] = (color * 60) & 0xff;
    palette[color * 3 + 1] = (color * 90) & 0xff;
    palette[color * 3 + 2] = (color * 120) & 0xff;
  }
  const indices = new Uint8Array(width * height);
  for (let pixel = 0; pixel < indices.length; pixel += 1) indices[pixel] = pixel % 4;
  const box: Rect = { x: 1, y: 1, width: 3, height: 2 };

  const cropped = cropPngBytes(
    encodeFixturePng({
      pixels: indices,
      width,
      height,
      channels: 1,
      colorType: 3,
      palette,
      filterFor: () => 0,
    }),
    box,
    LABEL,
  )!;

  const decoded = readPngForTest(cropped);
  assert.equal(decoded.colorType, 6, 'the general reader keeps its RGBA output');
  for (let row = 0; row < box.height; row += 1) {
    for (let column = 0; column < box.width; column += 1) {
      const color = indices[(row + box.y) * width + column + box.x]!;
      const to = (row * box.width + column) * 4;
      assert.deepEqual(
        [decoded.rgba[to], decoded.rgba[to + 1], decoded.rgba[to + 2]],
        [palette[color * 3], palette[color * 3 + 1], palette[color * 3 + 2]],
        `pixel ${column},${row}`,
      );
    }
  }
});

test('a grayscale capture crops through the general reader', () => {
  const width = 5;
  const height = 4;
  const gray = new Uint8Array(width * height);
  for (let pixel = 0; pixel < gray.length; pixel += 1) gray[pixel] = (pixel * 21) & 0xff;
  const box: Rect = { x: 2, y: 1, width: 2, height: 2 };

  const cropped = cropPngBytes(
    encodeFixturePng({ pixels: gray, width, height, channels: 1, colorType: 0 }),
    box,
    LABEL,
  )!;

  const decoded = readPngForTest(cropped);
  for (let row = 0; row < box.height; row += 1) {
    for (let column = 0; column < box.width; column += 1) {
      const wanted = gray[(row + box.y) * width + column + box.x]!;
      const to = (row * box.width + column) * 4;
      assert.deepEqual(
        [decoded.rgba[to], decoded.rgba[to + 1], decoded.rgba[to + 2]],
        [wanted, wanted, wanted],
        `pixel ${column},${row}`,
      );
    }
  }
});

test('a box covering the whole image returns no replacement bytes', () => {
  assert.equal(cropPngBytes(encodeFixturePng(claimable(6, 4)), fullBox(6, 4), LABEL), null);
});

test('a box covering the whole image still refuses a file that cannot be decoded', () => {
  const buffer = encodeFixturePng(claimable(12, 9));

  assert.throws(
    () => cropPngBytes(Buffer.from(buffer.subarray(0, buffer.length - 8)), fullBox(12, 9), LABEL),
    /Failed to decode screenshot as PNG/,
  );
});

test('an unreadable scanline filter below the box reports the decode failure', () => {
  const buffer = encodeFixturePng({
    ...claimable(6, 8),
    filterFor: (row) => (row === 7 ? 9 : 0),
  });

  assert.throws(
    () => cropPngBytes(buffer, { x: 0, y: 0, width: 3, height: 3 }, LABEL),
    /Failed to decode screenshot as PNG/,
  );
});

test('bytes trailing the end of the image report the canonical decode failure', () => {
  const withTrailer = Buffer.concat([
    encodeFixturePng(claimable(12, 9)),
    Buffer.from([0, 0, 1, 2]),
  ]);

  assert.throws(
    () => cropPngBytes(withTrailer, { x: 1, y: 1, width: 4, height: 4 }, LABEL),
    /Failed to decode screenshot as PNG/,
  );
});

test('a corrupted image header is refused instead of cropping by its claimed dimensions', () => {
  const corrupted = corruptChunkChecksum(encodeFixturePng(claimable(12, 9)), 'IHDR');

  assert.throws(
    () => cropPngBytes(corrupted, { x: 0, y: 0, width: 4, height: 4 }, LABEL),
    /Failed to decode screenshot as PNG/,
  );
});

test('a box beyond the image reports the box instead of clamping the crop', () => {
  assert.throws(
    () =>
      cropPngBytes(encodeFixturePng(claimable(6, 4)), { x: 4, y: 0, width: 3, height: 2 }, LABEL),
    /Screenshot crop box 3x2 at \(4, 0\) exceeds the 6x4 image/,
  );
});

test('bytes that are not a PNG report the canonical decode failure', () => {
  assert.throws(
    () => cropPngBytes(Buffer.from('not a png at all'), { x: 0, y: 0, width: 2, height: 2 }, LABEL),
    /Failed to decode screenshot as PNG/,
  );
});

test('a file truncated inside its image data reports the decode failure', () => {
  const buffer = encodeFixturePng(claimable(12, 9));

  assert.throws(
    () =>
      cropPngBytes(
        Buffer.from(buffer.subarray(0, buffer.length - 8)),
        { ...fullBox(12, 9), width: 4, height: 4 },
        LABEL,
      ),
    /Failed to decode screenshot as PNG/,
  );
});

test('a corrupted image-data checksum is refused instead of cropping wrong pixels', () => {
  const corrupted = corruptChunkChecksum(encodeFixturePng(claimable(12, 9)), 'IDAT');

  assert.throws(
    () => cropPngBytes(corrupted, { x: 0, y: 0, width: 4, height: 4 }, LABEL),
    /Failed to decode screenshot as PNG/,
  );
});

test('every crop of a random capture matches the pixels the file declares', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 24 }),
      fc.integer({ min: 1, max: 24 }),
      fc.nat(),
      fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 1 }),
      (width, height, boxSeed, filterPlan) => {
        const image: PngFixture = {
          ...claimable(width, height),
          filterFor: (row) => filterPlan[row % filterPlan.length]!,
        };
        const x = boxSeed % width;
        const y = (boxSeed >>> 4) % height;
        const box: Rect = {
          x,
          y,
          width: 1 + (boxSeed % (width - x)),
          height: 1 + ((boxSeed >>> 8) % (height - y)),
        };

        const cropped = cropPngBytes(encodeFixturePng(image), box, LABEL);

        if (box.x === 0 && box.y === 0 && box.width === width && box.height === height) {
          assert.equal(cropped, null);
          return;
        }
        assert.notEqual(cropped, null);
        assertCroppedPixels(cropped!, image, box);
      },
    ),
    { numRuns: PROPERTY_RUNS },
  );
});

function claimable(width: number, height: number): PngFixture {
  return {
    pixels: rampPixels(width, height, 4, () => OPAQUE),
    width,
    height,
    channels: 4,
    colorType: 6,
  };
}

function translucentAt(
  width: number,
  height: number,
  translucent: Readonly<{ x: number; y: number }>,
): PngFixture {
  return {
    ...claimable(width, height),
    pixels: rampPixels(width, height, 4, (x, y) =>
      x === translucent.x && y === translucent.y ? 128 : OPAQUE,
    ),
  };
}

function fullBox(width: number, height: number): Rect {
  return { x: 0, y: 0, width, height };
}

function assertCroppedPixels(cropped: Buffer, image: PngFixture, box: Rect): void {
  const decoded = readPngForTest(cropped);
  assert.deepEqual([decoded.width, decoded.height], [box.width, box.height]);
  for (let row = 0; row < box.height; row += 1) {
    for (let column = 0; column < box.width; column += 1) {
      const from = ((row + box.y) * image.width + column + box.x) * image.channels;
      const to = (row * box.width + column) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        assert.equal(
          decoded.rgba[to + channel]!,
          image.pixels[from + channel]!,
          `pixel ${column},${row} channel ${channel}`,
        );
      }
    }
  }
}
