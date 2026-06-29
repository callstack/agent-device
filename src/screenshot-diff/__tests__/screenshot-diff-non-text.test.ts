import assert from 'node:assert/strict';
import { test } from 'vitest';
import { summarizeNonTextDiffDeltas } from '../screenshot-diff-non-text.ts';
import { normalizedRect } from '../../utils/screenshot-geometry.ts';

function paintMaskRect(
  mask: Uint8Array,
  imageWidth: number,
  rect: { x: number; y: number; width: number; height: number },
): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      mask[y * imageWidth + x] = 1;
    }
  }
}

test('summarizeNonTextDiffDeltas masks OCR text and reports leading icon residuals', () => {
  const width = 220;
  const height = 120;
  const diffMask = new Uint8Array(width * height);
  paintMaskRect(diffMask, width, { x: 20, y: 30, width: 20, height: 20 });
  paintMaskRect(diffMask, width, { x: 70, y: 32, width: 48, height: 12 });

  const deltas = summarizeNonTextDiffDeltas({
    diffMask,
    width,
    height,
    regions: [
      {
        index: 1,
        rect: { x: 0, y: 20, width: 180, height: 50 },
        normalizedRect: normalizedRect({ x: 0, y: 16.67, width: 81.82, height: 41.67 }),
        differentPixels: 976,
        shareOfDiffPercentage: 100,
        densityPercentage: 10.84,
        shape: 'horizontal-band',
        size: 'medium',
        location: 'center',
        averageBaselineColorHex: '#000000',
        averageCurrentColorHex: '#ffffff',
        baselineLuminance: 0,
        currentLuminance: 255,
        dominantChange: 'brighter',
      },
    ],
    ocr: {
      provider: 'tesseract',
      baselineBlocks: 1,
      currentBlocks: 1,
      baselineBlocksRaw: [],
      currentBlocksRaw: [
        {
          text: 'Wi-Fi',
          confidence: 90,
          rect: { x: 68, y: 28, width: 60, height: 24 },
          normalizedRect: normalizedRect({ x: 30.91, y: 23.33, width: 27.27, height: 20 }),
        },
      ],
      matches: [],
    },
  });

  assert.equal(deltas.length, 1);
  assert.equal(deltas[0]?.regionIndex, 1);
  assert.equal(deltas[0]?.slot, 'leading');
  assert.equal(deltas[0]?.likelyKind, 'icon');
  assert.deepEqual(deltas[0]?.rect, { x: 20, y: 30, width: 20, height: 20 });
  assert.equal(deltas[0]?.nearestText, 'Wi-Fi');
});

test('summarizeNonTextDiffDeltas uses overlapping baseline text when current OCR misses a row', () => {
  const width = 220;
  const height = 120;
  const diffMask = new Uint8Array(width * height);
  paintMaskRect(diffMask, width, { x: 20, y: 30, width: 20, height: 20 });

  const deltas = summarizeNonTextDiffDeltas({
    diffMask,
    width,
    height,
    regions: [],
    ocr: {
      provider: 'tesseract',
      baselineBlocks: 1,
      currentBlocks: 0,
      baselineBlocksRaw: [
        {
          text: 'Wi-Fi',
          confidence: 90,
          rect: { x: 68, y: 28, width: 60, height: 24 },
          normalizedRect: normalizedRect({ x: 30.91, y: 23.33, width: 27.27, height: 20 }),
        },
      ],
      currentBlocksRaw: [],
      matches: [],
    },
  });

  assert.equal(deltas.length, 1);
  assert.equal(deltas[0]?.slot, 'leading');
  assert.equal(deltas[0]?.likelyKind, 'icon');
  assert.equal(deltas[0]?.nearestText, 'Wi-Fi');
});

test('summarizeNonTextDiffDeltas omits broad background residuals', () => {
  const width = 220;
  const height = 120;
  const diffMask = new Uint8Array(width * height);
  paintMaskRect(diffMask, width, { x: 10, y: 30, width: 180, height: 40 });

  const deltas = summarizeNonTextDiffDeltas({
    diffMask,
    width,
    height,
    regions: [
      {
        index: 1,
        rect: { x: 10, y: 30, width: 180, height: 40 },
        normalizedRect: normalizedRect({ x: 4.55, y: 25, width: 81.82, height: 33.33 }),
        differentPixels: 7200,
        shareOfDiffPercentage: 100,
        densityPercentage: 100,
        shape: 'large-area',
        size: 'large',
        location: 'center',
        averageBaselineColorHex: '#000000',
        averageCurrentColorHex: '#ffffff',
        baselineLuminance: 0,
        currentLuminance: 255,
        dominantChange: 'brighter',
      },
    ],
  });

  assert.deepEqual(deltas, []);
});
