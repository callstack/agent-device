import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from '../../utils/png.ts';
import { compareScreenshots } from '../screenshot-diff.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-screenshot-diff-'));
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
  assert.equal(result.dimensionMismatch, undefined);
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

test('dimension mismatch returns expected vs actual sizes', async () => {
  const dir = tmpDir();
  const baseline = path.join(dir, 'baseline.png');
  const current = path.join(dir, 'current.png');
  const diffOut = path.join(dir, 'diff.png');

  writeSolidPng(baseline, 10, 20, { r: 0, g: 0, b: 0 });
  writeSolidPng(current, 15, 25, { r: 0, g: 0, b: 0 });

  const result = await compareScreenshots(baseline, current, { outputPath: diffOut });

  assert.equal(result.match, false);
  assert.equal(result.mismatchPercentage, 100);
  assert.equal(result.diffPath, undefined, 'diffPath should not be set for dimension mismatch');
  assert.equal(result.regions, undefined);
  assert.equal(result.ocr, undefined);
  assert.equal(result.nonTextDeltas, undefined);
  assert.deepEqual(result.dimensionMismatch, {
    expected: { width: 10, height: 20 },
    actual: { width: 15, height: 25 },
  });
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

test('throws COMMAND_FAILED for invalid PNG data', async () => {
  const dir = tmpDir();
  const baseline = path.join(dir, 'baseline.png');
  const current = path.join(dir, 'current.png');

  fs.writeFileSync(baseline, 'not a png file');
  writeSolidPng(current, 5, 5, { r: 0, g: 0, b: 0 });

  await assert.rejects(
    () => compareScreenshots(baseline, current),
    (err: any) => {
      assert.equal(err.code, 'COMMAND_FAILED');
      assert.match(err.message, /Failed to decode baseline screenshot/);
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
