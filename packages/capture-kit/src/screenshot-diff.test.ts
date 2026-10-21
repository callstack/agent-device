import { test } from 'vitest';
import fc from 'fast-check';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';

import { hasPngSignature, PNG } from './png.ts';
import { compareScreenshots } from './screenshot-diff.ts';

function tmpDir(): string {
  return mkdtempForTestSync('agent-device-screenshot-diff-');
}

/** Create a solid-color PNG and write it to disk. */
function writeSolidPng(
  filePath: string,
  width: number,
  height: number,
  color: { r: number; g: number; b: number },
): void {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = color.r;
    png.data[i + 1] = color.g;
    png.data[i + 2] = color.b;
    png.data[i + 3] = 255;
  }
  fs.writeFileSync(filePath, PNG.sync.write(png));
}

/** Encode a solid-color JPEG, so a test can hand the comparison a lossy container. */
async function writeSolidJpeg(
  filePath: string,
  width: number,
  height: number,
  color: { r: number; g: number; b: number },
): Promise<Buffer> {
  const { encode } = await import('jpeg-js');
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = color.r;
    data[i + 1] = color.g;
    data[i + 2] = color.b;
    data[i + 3] = 255;
  }
  const jpeg = Buffer.from(encode({ width, height, data }, 90).data);
  fs.writeFileSync(filePath, jpeg);
  return jpeg;
}

function paintRect(
  png: PNG,
  rect: { x: number; y: number; width: number; height: number },
  color: { r: number; g: number; b: number },
): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const index = (y * png.width + x) * 4;
      png.data[index] = color.r;
      png.data[index + 1] = color.g;
      png.data[index + 2] = color.b;
      png.data[index + 3] = 255;
    }
  }
}

test('identical images produce match: true with 0% mismatch', async () => {
  const dir = tmpDir();
  const baseline = path.join(dir, 'baseline.png');
  const current = path.join(dir, 'current.png');
  const diffOut = path.join(dir, 'diff.png');

  writeSolidPng(baseline, 10, 10, { r: 100, g: 150, b: 200 });
  writeSolidPng(current, 10, 10, { r: 100, g: 150, b: 200 });

  const result = await compareScreenshots(baseline, current, { outputPath: diffOut });

  assert.equal(result.match, true);
  assert.equal(result.differentPixels, 0);
  assert.equal(result.mismatchPercentage, 0);
  assert.equal(result.totalPixels, 100);
  assert.equal(result.ocr, undefined);
  assert.equal(result.nonTextDeltas, undefined);
  assert.equal(Object.hasOwn(result, 'ocr'), false);
  assert.equal(Object.hasOwn(result, 'nonTextDeltas'), false);
  assert.equal(Object.hasOwn(result, 'dimensionMismatch'), false);
  assert.equal(result.diffPath, undefined, 'diffPath should not be set when images match');
  // No diff image should be written when images match
  assert.equal(fs.existsSync(diffOut), false);
});

test('matching images delete an existing diff artifact at outputPath', async () => {
  const dir = tmpDir();
  const baseline = path.join(dir, 'baseline.png');
  const current = path.join(dir, 'current.png');
  const diffOut = path.join(dir, 'diff.png');

  writeSolidPng(baseline, 10, 10, { r: 100, g: 150, b: 200 });
  writeSolidPng(current, 10, 10, { r: 100, g: 150, b: 200 });
  fs.writeFileSync(diffOut, 'stale diff');

  const result = await compareScreenshots(baseline, current, { outputPath: diffOut });

  assert.equal(result.match, true);
  assert.equal(fs.existsSync(diffOut), false);
});

test('completely different images produce match: false with 100% mismatch', async () => {
  const dir = tmpDir();
  const baseline = path.join(dir, 'baseline.png');
  const current = path.join(dir, 'current.png');
  const diffOut = path.join(dir, 'diff.png');

  writeSolidPng(baseline, 10, 10, { r: 0, g: 0, b: 0 });
  writeSolidPng(current, 10, 10, { r: 255, g: 255, b: 255 });

  const result = await compareScreenshots(baseline, current, {
    outputPath: diffOut,
    threshold: 0,
  });

  assert.equal(result.match, false);
  assert.equal(result.differentPixels, 100);
  assert.equal(result.mismatchPercentage, 100);
  assert.equal(result.totalPixels, 100);
  assert.ok(fs.existsSync(diffOut), 'diff image should be written');
});

test('changed pixels are summarized into nearby diff regions', async () => {
  const dir = tmpDir();
  const baseline = path.join(dir, 'baseline.png');
  const current = path.join(dir, 'current.png');
  const diffOut = path.join(dir, 'diff.png');

  writeSolidPng(baseline, 40, 20, { r: 0, g: 0, b: 0 });

  const currentPng = new PNG({ width: 40, height: 20 });
  for (let i = 0; i < currentPng.data.length; i += 4) {
    currentPng.data[i] = 0;
    currentPng.data[i + 1] = 0;
    currentPng.data[i + 2] = 0;
    currentPng.data[i + 3] = 255;
  }
  paintRect(currentPng, { x: 2, y: 2, width: 4, height: 4 }, { r: 255, g: 255, b: 255 });
  paintRect(currentPng, { x: 10, y: 2, width: 4, height: 4 }, { r: 255, g: 255, b: 255 });
  paintRect(currentPng, { x: 30, y: 15, width: 4, height: 4 }, { r: 255, g: 255, b: 255 });
  fs.writeFileSync(current, PNG.sync.write(currentPng));

  const result = await compareScreenshots(baseline, current, {
    outputPath: diffOut,
    threshold: 0,
  });

  assert.equal(result.differentPixels, 48);
  assert.equal(result.regions?.length, 2);
  assert.deepEqual(result.regions?.[0]?.rect, { x: 2, y: 2, width: 12, height: 4 });
  assert.equal(result.regions?.[0]?.differentPixels, 32);
  assert.equal(result.regions?.[0]?.shareOfDiffPercentage, 66.67);
  assert.deepEqual(result.regions?.[0]?.normalizedRect, { x: 5, y: 10, width: 30, height: 20 });
  assert.equal(result.regions?.[0]?.densityPercentage, 66.67);
  assert.equal(result.regions?.[0]?.shape, 'horizontal-band');
  assert.equal(result.regions?.[0]?.size, 'large');
  assert.equal(result.regions?.[0]?.averageBaselineColorHex, '#000000');
  assert.equal(result.regions?.[0]?.averageCurrentColorHex, '#ffffff');
  assert.equal(result.regions?.[0]?.baselineLuminance, 0);
  assert.equal(result.regions?.[0]?.currentLuminance, 255);
  assert.equal(result.regions?.[0]?.location, 'top-left');
  assert.equal(result.regions?.[0]?.dominantChange, 'brighter');
  assert.deepEqual(result.regions?.[1]?.rect, { x: 30, y: 15, width: 4, height: 4 });

  const diffPng = PNG.sync.read(fs.readFileSync(diffOut));
  const borderPixel = (2 * diffPng.width + 2) * 4;
  assert.equal(diffPng.data[borderPixel], 0);
  assert.equal(diffPng.data[borderPixel + 1], 187);
  assert.equal(diffPng.data[borderPixel + 2], 255);
});

test('large connected diff regions are split at horizontal low-density bands', async () => {
  const dir = tmpDir();
  const baseline = path.join(dir, 'baseline.png');
  const current = path.join(dir, 'current.png');

  writeSolidPng(baseline, 100, 220, { r: 0, g: 0, b: 0 });

  const currentPng = new PNG({ width: 100, height: 220 });
  for (let i = 0; i < currentPng.data.length; i += 4) {
    currentPng.data[i] = 0;
    currentPng.data[i + 1] = 0;
    currentPng.data[i + 2] = 0;
    currentPng.data[i + 3] = 255;
  }
  paintRect(currentPng, { x: 0, y: 0, width: 100, height: 80 }, { r: 255, g: 255, b: 255 });
  paintRect(currentPng, { x: 50, y: 80, width: 1, height: 50 }, { r: 255, g: 255, b: 255 });
  paintRect(currentPng, { x: 0, y: 130, width: 100, height: 90 }, { r: 255, g: 255, b: 255 });
  fs.writeFileSync(current, PNG.sync.write(currentPng));

  const result = await compareScreenshots(baseline, current, {
    outputPath: path.join(dir, 'diff.png'),
    threshold: 0,
  });

  assert.equal(result.regions?.length, 2);
  const rectsByTop = result.regions?.map((region) => region.rect).sort((a, b) => a.y - b.y);
  assert.deepEqual(rectsByTop, [
    { x: 0, y: 0, width: 100, height: 106 },
    { x: 0, y: 106, width: 100, height: 114 },
  ]);
});

test('large connected diff regions are not split at short low-density bands', async () => {
  const dir = tmpDir();
  const baseline = path.join(dir, 'baseline.png');
  const current = path.join(dir, 'current.png');

  writeSolidPng(baseline, 100, 220, { r: 0, g: 0, b: 0 });

  const currentPng = new PNG({ width: 100, height: 220 });
  for (let i = 0; i < currentPng.data.length; i += 4) {
    currentPng.data[i] = 0;
    currentPng.data[i + 1] = 0;
    currentPng.data[i + 2] = 0;
    currentPng.data[i + 3] = 255;
  }
  paintRect(currentPng, { x: 0, y: 0, width: 100, height: 80 }, { r: 255, g: 255, b: 255 });
  paintRect(currentPng, { x: 50, y: 80, width: 1, height: 4 }, { r: 255, g: 255, b: 255 });
  paintRect(currentPng, { x: 0, y: 84, width: 100, height: 136 }, { r: 255, g: 255, b: 255 });
  fs.writeFileSync(current, PNG.sync.write(currentPng));

  const result = await compareScreenshots(baseline, current, {
    outputPath: path.join(dir, 'diff.png'),
    threshold: 0,
  });

  assert.equal(result.regions?.length, 1);
  assert.deepEqual(result.regions?.[0]?.rect, { x: 0, y: 0, width: 100, height: 220 });
});

test('no diff path is persisted when outputPath is omitted', async () => {
  const dir = tmpDir();
  const baseline = path.join(dir, 'baseline.png');
  const current = path.join(dir, 'current.png');

  writeSolidPng(baseline, 10, 10, { r: 0, g: 0, b: 0 });
  writeSolidPng(current, 10, 10, { r: 255, g: 255, b: 255 });

  const result = await compareScreenshots(baseline, current, { threshold: 0 });

  assert.equal(result.match, false);
  assert.equal(result.diffPath, undefined);
});

test('diff image marks changed pixels red over a light current-screen context', async () => {
  const dir = tmpDir();
  const baseline = path.join(dir, 'baseline.png');
  const current = path.join(dir, 'current.png');
  const diffOut = path.join(dir, 'diff.png');

  // 2x1 image: first pixel identical, second pixel different
  const baselinePng = new PNG({ width: 2, height: 1 });
  // pixel 0: white
  baselinePng.data[0] = 255;
  baselinePng.data[1] = 255;
  baselinePng.data[2] = 255;
  baselinePng.data[3] = 255;
  // pixel 1: black
  baselinePng.data[4] = 0;
  baselinePng.data[5] = 0;
  baselinePng.data[6] = 0;
  baselinePng.data[7] = 255;
  fs.writeFileSync(baseline, PNG.sync.write(baselinePng));

  const currentPng = new PNG({ width: 2, height: 1 });
  // pixel 0: white (same)
  currentPng.data[0] = 255;
  currentPng.data[1] = 255;
  currentPng.data[2] = 255;
  currentPng.data[3] = 255;
  // pixel 1: white (different from black)
  currentPng.data[4] = 255;
  currentPng.data[5] = 255;
  currentPng.data[6] = 255;
  currentPng.data[7] = 255;
  fs.writeFileSync(current, PNG.sync.write(currentPng));

  const result = await compareScreenshots(baseline, current, {
    outputPath: diffOut,
    threshold: 0,
  });

  assert.equal(result.differentPixels, 1);
  assert.equal(result.totalPixels, 2);

  // Read the diff image and verify pixel colors
  const diffPng = PNG.sync.read(fs.readFileSync(diffOut));

  // Pixel 0 (unchanged white): should stay light as screenshot context.
  assert.equal(diffPng.data[0], 255); // R
  assert.equal(diffPng.data[1], 255); // G
  assert.equal(diffPng.data[2], 255); // B

  // Pixel 1 (different): should be red-tinted while preserving light context.
  assert.equal(diffPng.data[4], 228); // R
  assert.equal(diffPng.data[5], 56); // G
  assert.equal(diffPng.data[6], 56); // B
});

test('different dimensions scale current to baseline width and count missing bottom rows', async () => {
  const dir = tmpDir();
  const baseline = path.join(dir, 'baseline.png');
  const current = path.join(dir, 'current.png');
  const diffOut = path.join(dir, 'diff.png');
  writeSolidPng(baseline, 10, 20, { r: 0, g: 0, b: 0 });
  writeSolidPng(current, 15, 25, { r: 0, g: 0, b: 0 });
  const original = fs.readFileSync(current);

  const result = await compareScreenshots(baseline, current, { outputPath: diffOut, threshold: 1 });

  assert.equal(result.match, false);
  assert.equal(result.differentPixels, 30);
  assert.equal(result.totalPixels, 200);
  assert.equal(result.mismatchPercentage, 15);
  assert.equal(result.diffPath, diffOut);
  assert.equal(Object.hasOwn(result, 'dimensionMismatch'), false);
  assert.deepEqual(result.normalization, {
    baseline: { width: 10, height: 20 },
    current: { width: 15, height: 25 },
    scaledCurrent: { width: 10, height: 17 },
    compared: { width: 10, height: 20 },
    currentScale: { x: 10 / 15, y: 17 / 25 },
    alignment: 'top-left',
    coordinateSpace: 'comparison-pixels',
  });
  assert.deepEqual(result.regions?.[0]?.rect, { x: 0, y: 17, width: 10, height: 3 });
  assert.deepEqual(fs.readFileSync(current), original);
  const diff = PNG.sync.read(fs.readFileSync(diffOut));
  assert.deepEqual([diff.width, diff.height], [10, 20]);
});

test('threshold controls sensitivity: small differences ignored at default threshold', async () => {
  const dir = tmpDir();
  const baseline = path.join(dir, 'baseline.png');
  const current = path.join(dir, 'current.png');

  // Colors differ by just a few units — within default threshold of 0.1
  writeSolidPng(baseline, 5, 5, { r: 100, g: 100, b: 100 });
  writeSolidPng(current, 5, 5, { r: 105, g: 105, b: 105 });

  const loose = await compareScreenshots(baseline, current, {
    outputPath: path.join(dir, 'diff-loose.png'),
    threshold: 0.1,
  });
  assert.equal(loose.match, true, 'small color difference should be ignored at 0.1 threshold');

  const strict = await compareScreenshots(baseline, current, {
    outputPath: path.join(dir, 'diff-strict.png'),
    threshold: 0,
  });
  assert.equal(strict.match, false, 'small color difference should be detected at 0 threshold');
  assert.equal(strict.differentPixels, 25);
});

test.each([
  [
    { r: 0, g: 0, b: 0 },
    { r: 255, g: 255, b: 255 },
  ],
  [
    { r: 255, g: 0, b: 0 },
    { r: 0, g: 255, b: 255 },
  ],
  [
    { r: 0, g: 255, b: 0 },
    { r: 255, g: 0, b: 255 },
  ],
  [
    { r: 0, g: 0, b: 255 },
    { r: 255, g: 255, b: 0 },
  ],
])('threshold 1 includes the maximum RGB distance from %j to %j', async (before, after) => {
  const dir = tmpDir();
  const baseline = path.join(dir, 'baseline.png');
  const current = path.join(dir, 'current.png');
  const outputPath = path.join(dir, 'diff.png');
  writeSolidPng(baseline, 2, 2, before);
  writeSolidPng(current, 2, 2, after);

  const belowMaximum = await compareScreenshots(baseline, current, {
    threshold: 1 - Number.EPSILON / 2,
    outputPath,
  });
  assert.equal(belowMaximum.match, false);
  assert.equal(belowMaximum.differentPixels, 4);
  assert.equal(fs.existsSync(outputPath), true);

  const maximum = await compareScreenshots(baseline, current, { threshold: 1, outputPath });
  assert.equal(maximum.match, true);
  assert.equal(maximum.differentPixels, 0);
  assert.equal(maximum.mismatchPercentage, 0);
  assert.equal(maximum.totalPixels, 4);
  assert.equal(maximum.regions, undefined);
  assert.equal(maximum.diffPath, undefined);
  assert.equal(fs.existsSync(outputPath), false);
});

test('throws INVALID_ARGS when baseline file does not exist', async () => {
  const dir = tmpDir();
  const current = path.join(dir, 'current.png');
  writeSolidPng(current, 5, 5, { r: 0, g: 0, b: 0 });

  await assert.rejects(
    () => compareScreenshots(path.join(dir, 'missing.png'), current),
    (err: any) => {
      assert.equal(err.code, 'INVALID_ARGS');
      assert.match(err.message, /Baseline image not found/);
      return true;
    },
  );
});

test('throws INVALID_ARGS when current file does not exist', async () => {
  const dir = tmpDir();
  const baseline = path.join(dir, 'baseline.png');
  writeSolidPng(baseline, 5, 5, { r: 0, g: 0, b: 0 });

  await assert.rejects(
    () => compareScreenshots(baseline, path.join(dir, 'missing.png')),
    (err: any) => {
      assert.equal(err.code, 'INVALID_ARGS');
      assert.match(err.message, /Current screenshot not found/);
      return true;
    },
  );
});

test('throws COMMAND_FAILED for bytes in neither supported container', async () => {
  const dir = tmpDir();
  const baseline = path.join(dir, 'baseline.png');
  const current = path.join(dir, 'current.png');

  fs.writeFileSync(baseline, 'not a png file');
  writeSolidPng(current, 5, 5, { r: 0, g: 0, b: 0 });

  await assert.rejects(
    () => compareScreenshots(baseline, current),
    (err: any) => {
      assert.equal(err.code, 'COMMAND_FAILED');
      assert.match(err.message, /baseline screenshot is neither PNG nor JPEG/);
      return true;
    },
  );
});

test('a JPEG stored under a .png name compares as a match', async () => {
  const dir = tmpDir();
  const baseline = path.join(dir, 'baseline.png');
  const current = path.join(dir, 'current.png');

  // The `.png` names hold JPEG bytes on purpose: the container is sniffed from the bytes.
  const jpeg = await writeSolidJpeg(baseline, 8, 6, { r: 20, g: 200, b: 40 });
  fs.writeFileSync(current, jpeg);

  // The same stored bytes decode to the same pixels, so this pins an exact comparison.
  const result = await compareScreenshots(baseline, current, { threshold: 0 });

  assert.equal(result.match, true);
  assert.equal(result.differentPixels, 0);
  assert.equal(result.totalPixels, 48);
});

test('a JPEG comparison writes the diff artifact as PNG', async () => {
  const dir = tmpDir();
  const baseline = path.join(dir, 'baseline.jpg');
  const current = path.join(dir, 'current.jpg');
  const diffPath = path.join(dir, 'diff.png');

  await writeSolidJpeg(baseline, 8, 6, { r: 20, g: 200, b: 40 });
  await writeSolidJpeg(current, 8, 6, { r: 200, g: 20, b: 40 });

  const result = await compareScreenshots(baseline, current, { outputPath: diffPath });

  assert.equal(result.match, false);
  assert.equal(result.diffPath, diffPath);
  assert.equal(hasPngSignature(fs.readFileSync(diffPath)), true);
});

test('a JPEG input scales to baseline width and counts extra rows', async () => {
  const dir = tmpDir();
  const baseline = path.join(dir, 'baseline.jpg');
  const current = path.join(dir, 'current.png');
  await writeSolidJpeg(baseline, 8, 6, { r: 20, g: 200, b: 40 });
  writeSolidPng(current, 5, 5, { r: 20, g: 200, b: 40 });

  const result = await compareScreenshots(baseline, current);

  assert.equal(result.match, false);
  assert.equal(result.totalPixels, 64);
  assert.equal(result.differentPixels, 16);
  assert.deepEqual(result.normalization?.scaledCurrent, { width: 8, height: 8 });
  assert.deepEqual(result.normalization?.compared, { width: 8, height: 8 });
});

test('JPEG bytes that do not decode are refused with the JPEG decode error', async () => {
  const dir = tmpDir();
  const baseline = path.join(dir, 'baseline.jpg');
  const current = path.join(dir, 'current.png');

  fs.writeFileSync(
    baseline,
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 0x41)]),
  );
  writeSolidPng(current, 5, 5, { r: 0, g: 0, b: 0 });

  await assert.rejects(
    () => compareScreenshots(baseline, current),
    (err: any) => {
      assert.equal(err.code, 'COMMAND_FAILED');
      assert.match(err.message, /Failed to decode baseline screenshot as JPEG/);
      return true;
    },
  );
});

test('mismatchPercentage is rounded to 2 decimal places', async () => {
  const dir = tmpDir();
  const baseline = path.join(dir, 'baseline.png');
  const current = path.join(dir, 'current.png');

  // 3x1 image: change 1 of 3 pixels → 33.333...%
  const baselinePng = new PNG({ width: 3, height: 1 });
  const currentPng = new PNG({ width: 3, height: 1 });
  for (let i = 0; i < 12; i += 4) {
    baselinePng.data[i] = 0;
    baselinePng.data[i + 1] = 0;
    baselinePng.data[i + 2] = 0;
    baselinePng.data[i + 3] = 255;
    currentPng.data[i] = 0;
    currentPng.data[i + 1] = 0;
    currentPng.data[i + 2] = 0;
    currentPng.data[i + 3] = 255;
  }
  // Make the last pixel different
  currentPng.data[8] = 255;
  currentPng.data[9] = 255;
  currentPng.data[10] = 255;

  fs.writeFileSync(baseline, PNG.sync.write(baselinePng));
  fs.writeFileSync(current, PNG.sync.write(currentPng));

  const result = await compareScreenshots(baseline, current, {
    outputPath: path.join(dir, 'diff.png'),
    threshold: 0,
  });

  assert.equal(result.mismatchPercentage, 33.33);
});

test('375x812 reference compares with a 1080x2340 capture and retains the extra row', async () => {
  const dir = tmpDir();
  const baseline = path.join(dir, 'reference.png');
  const current = path.join(dir, 'capture.png');
  writeSolidPng(baseline, 375, 812, { r: 30, g: 80, b: 120 });
  writeSolidPng(current, 1080, 2340, { r: 30, g: 80, b: 120 });
  const result = await compareScreenshots(baseline, current, { threshold: 0 });
  assert.equal(result.differentPixels, 375);
  assert.equal(result.totalPixels, 304875);
  assert.equal(result.mismatchPercentage, 0.12);
  assert.deepEqual(result.normalization?.scaledCurrent, { width: 375, height: 813 });
});

test.each([0, 255])(
  'transparent and blank tails count in either direction (alpha %i)',
  async (alpha) => {
    const dir = tmpDir();
    const short = path.join(dir, 'short.png');
    const tall = path.join(dir, 'tall.png');
    for (const [file, height] of [
      [short, 2],
      [tall, 4],
    ] as const) {
      const png = new PNG({ width: 4, height });
      for (let offset = 3; offset < png.data.length; offset += 4) png.data[offset] = alpha;
      fs.writeFileSync(file, PNG.sync.write(png));
    }
    for (const [baseline, current] of [
      [short, tall],
      [tall, short],
    ]) {
      const result = await compareScreenshots(baseline!, current!, { threshold: 1 });
      assert.equal(result.differentPixels, 8);
      assert.equal(result.totalPixels, 16);
      assert.equal(result.mismatchPercentage, 50);
      assert.deepEqual(result.regions?.[0]?.rect, { x: 0, y: 2, width: 4, height: 2 });
      assert.deepEqual(result.regions?.[0]?.normalizedRect, {
        x: 0,
        y: 50,
        width: 100,
        height: 50,
      });
    }
  },
);

test('scaled content stays aligned at top left and regions use comparison pixels', async () => {
  const dir = tmpDir();
  const baseline = path.join(dir, 'baseline.png');
  const current = path.join(dir, 'current.png');
  const source = new PNG({ width: 4, height: 4 });
  paintRect(source, { x: 0, y: 0, width: 2, height: 2 }, { r: 255, g: 255, b: 255 });
  fs.writeFileSync(current, PNG.sync.write(source));
  writeSolidPng(baseline, 2, 2, { r: 0, g: 0, b: 0 });
  const result = await compareScreenshots(baseline, current, { threshold: 0 });
  assert.equal(result.differentPixels, 1);
  assert.deepEqual(result.regions?.[0]?.rect, { x: 0, y: 0, width: 1, height: 1 });
  assert.deepEqual(result.regions?.[0]?.normalizedRect, { x: 0, y: 0, width: 50, height: 50 });
});

const PROPERTY_RUNS = 40;
test('proportional captures match at narrower, wider and equal widths', async () => {
  const dir = tmpDir();
  const baseline = path.join(dir, 'baseline.png');
  const current = path.join(dir, 'current.png');
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        width: fc.integer({ min: 1, max: 12 }),
        height: fc.integer({ min: 1, max: 12 }),
        baselineDensity: fc.integer({ min: 1, max: 4 }),
        currentDensity: fc.integer({ min: 1, max: 4 }),
      }),
      async ({ width, height, baselineDensity, currentDensity }) => {
        writeSolidPng(baseline, width * baselineDensity, height * baselineDensity, {
          r: 32,
          g: 80,
          b: 120,
        });
        writeSolidPng(current, width * currentDensity, height * currentDensity, {
          r: 32,
          g: 80,
          b: 120,
        });
        const result = await compareScreenshots(baseline, current, { threshold: 0 });
        assert.equal(result.match, true);
        assert.equal(result.totalPixels, width * height * baselineDensity ** 2);
      },
    ),
    { numRuns: PROPERTY_RUNS },
  );
});

test.each([
  [10, 10, 20, 20, 399], // original current exceeds budget even though downscaling fits
  [20, 20, 10, 10, 399], // original baseline exceeds budget
  [10, 1, 1, 100, 100], // both originals fit; normalized/union canvas exceeds budget
])(
  'pixel budget bounds original and scaled images (%i,%i vs %i,%i)',
  async (bw, bh, cw, ch, maxPixels) => {
    const dir = tmpDir();
    const baseline = path.join(dir, 'baseline.png');
    const current = path.join(dir, 'current.png');
    writeSolidPng(baseline, bw, bh, { r: 0, g: 0, b: 0 });
    writeSolidPng(current, cw, ch, { r: 0, g: 0, b: 0 });
    await assert.rejects(compareScreenshots(baseline, current, { maxPixels }), {
      code: 'INVALID_ARGS',
    });
  },
);

test('fractional downscaling keeps at least one row and accepts the exact union budget', async () => {
  const dir = tmpDir();
  const baseline = path.join(dir, 'baseline.png');
  const current = path.join(dir, 'current.png');
  writeSolidPng(baseline, 1, 1, { r: 0, g: 0, b: 0 });
  writeSolidPng(current, 100, 1, { r: 0, g: 0, b: 0 });
  const result = await compareScreenshots(baseline, current, { maxPixels: 100 });
  assert.equal(result.match, true);
  assert.deepEqual(result.normalization?.scaledCurrent, { width: 1, height: 1 });
});

test.each([
  [4, 2, 8, 4],
  [8, 4, 4, 2],
])(
  'proportional patterned screenshots match at either density (%i x %i vs %i x %i)',
  async (bw, bh, cw, ch) => {
    const dir = tmpDir();
    const baseline = path.join(dir, 'baseline.png');
    const current = path.join(dir, 'current.png');
    for (const [file, width, height] of [
      [baseline, bw, bh],
      [current, cw, ch],
    ] as const) {
      const png = new PNG({ width, height });
      paintRect(png, { x: 0, y: 0, width: width / 2, height: height / 2 }, { r: 255, g: 0, b: 0 });
      paintRect(
        png,
        { x: width / 2, y: height / 2, width: width / 2, height: height / 2 },
        { r: 0, g: 80, b: 255 },
      );
      fs.writeFileSync(file, PNG.sync.write(png));
    }
    const result = await compareScreenshots(baseline, current, { threshold: 0 });
    assert.equal(result.match, true);
    assert.equal(result.totalPixels, bw * bh);
  },
);

test('JPEG current screenshots use proportional normalization and the original pixel budget', async () => {
  const dir = tmpDir();
  const baseline = path.join(dir, 'baseline.png');
  const current = path.join(dir, 'current.jpg');
  writeSolidPng(baseline, 4, 3, { r: 20, g: 200, b: 40 });
  await writeSolidJpeg(current, 8, 6, { r: 20, g: 200, b: 40 });
  const result = await compareScreenshots(baseline, current, { maxPixels: 48 });
  assert.equal(result.match, true);
  assert.equal(result.totalPixels, 12);
  await assert.rejects(compareScreenshots(baseline, current, { maxPixels: 47 }), {
    code: 'INVALID_ARGS',
  });
});

test('unequal-height screenshots keep shared content at the top left', async () => {
  const dir = tmpDir();
  const baseline = path.join(dir, 'baseline.png');
  const current = path.join(dir, 'current.png');
  for (const [file, width, height] of [
    [baseline, 2, 2],
    [current, 4, 6],
  ] as const) {
    const image = new PNG({ width, height });
    paintRect(
      image,
      { x: 0, y: 0, width: width / 2, height: width / 2 },
      { r: 255, g: 255, b: 255 },
    );
    fs.writeFileSync(file, PNG.sync.write(image));
  }
  const result = await compareScreenshots(baseline, current, { threshold: 0 });
  assert.equal(result.differentPixels, 2);
  assert.equal(result.totalPixels, 6);
  assert.deepEqual(result.regions?.[0]?.rect, { x: 0, y: 2, width: 2, height: 1 });
});
