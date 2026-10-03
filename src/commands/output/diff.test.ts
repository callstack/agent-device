import { test } from 'vitest';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import path from 'node:path';
import { formatScreenshotDiffText, formatSnapshotDiffText } from './diff.ts';
import { normalizedRect } from '@agent-device/kernel/screenshot-geometry';
import { withNoColor } from '../../__tests__/test-utils/color.ts';

const DIFF_DATA = {
  mode: 'snapshot',
  baselineInitialized: false,
  summary: { additions: 1, removals: 1, unchanged: 1 },
  lines: [
    { kind: 'unchanged', text: '@e2 [window]' },
    { kind: 'removed', text: '  @e3 [text] "67"' },
    { kind: 'added', text: '  @e3 [text] "134"' },
  ],
} as const;

test('formatSnapshotDiffText renders plain text when color is disabled', () => {
  const originalForceColor = process.env.FORCE_COLOR;
  const originalNoColor = process.env.NO_COLOR;
  process.env.FORCE_COLOR = '0';
  delete process.env.NO_COLOR;
  try {
    const text = formatSnapshotDiffText({ ...DIFF_DATA });
    assert.match(text, /^@e2 \[window\]/m);
    assert.match(text, /^- {2}@e3 \[text\] "67"$/m);
    assert.match(text, /^\+ {2}@e3 \[text\] "134"$/m);
    assert.match(text, /1 additions, 1 removals, 1 unchanged/);
    assert.equal(text.includes('\u001b['), false);
  } finally {
    if (typeof originalForceColor === 'string') process.env.FORCE_COLOR = originalForceColor;
    else delete process.env.FORCE_COLOR;
    if (typeof originalNoColor === 'string') process.env.NO_COLOR = originalNoColor;
    else delete process.env.NO_COLOR;
  }
});

test('formatSnapshotDiffText renders ANSI colors when forced', () => {
  const text = withColor(() => formatSnapshotDiffText({ ...DIFF_DATA }));
  const plainText = stripVTControlCharacters(text);
  assert.notEqual(text, plainText);
  assert.match(plainText, /^@e2 \[window\]/m);
  assert.match(plainText, /^- {2}@e3 \[text\] "67"$/m);
  assert.match(plainText, /^\+ {2}@e3 \[text\] "134"$/m);
  assert.match(plainText, /1 additions, 1 removals, 1 unchanged/);
});

test('formatSnapshotDiffText prints warnings before the diff body', () => {
  const text = withNoColor(() =>
    formatSnapshotDiffText({
      ...DIFF_DATA,
      warnings: ['Recent press was followed by a nearly identical snapshot.'],
    }),
  );
  assert.match(text, /^Recent press was followed by a nearly identical snapshot\.$/m);
  assert.match(text, /^@e2 \[window\]$/m);
  assert.match(text, /1 additions, 1 removals, 1 unchanged/);
});

test('formatScreenshotDiffText renders match success without color', () => {
  const text = withNoColor(() =>
    formatScreenshotDiffText({
      match: true,
      differentPixels: 0,
      totalPixels: 100,
      mismatchPercentage: 0,
    }),
  );
  assert.match(text, /✓ Screenshots match\./);
  assert.equal(text.includes('\u001b['), false);
});

test('formatScreenshotDiffText renders mismatch with pixel counts without color', () => {
  const text = withNoColor(() =>
    formatScreenshotDiffText({
      match: false,
      differentPixels: 500,
      totalPixels: 10000,
      mismatchPercentage: 5,
      diffPath: '/tmp/test/diff.png',
      currentOverlayPath: '/tmp/test/diff.current-overlay.png',
      currentOverlayRefCount: 1,
      regions: [
        {
          index: 1,
          rect: { x: 10, y: 20, width: 100, height: 40 },
          normalizedRect: normalizedRect({ x: 10, y: 20, width: 100, height: 40 }),
          differentPixels: 350,
          shareOfDiffPercentage: 70,
          densityPercentage: 87.5,
          shape: 'horizontal-band',
          size: 'small',
          location: 'top-left',
          averageBaselineColorHex: '#000000',
          averageCurrentColorHex: '#ffffff',
          baselineLuminance: 0,
          currentLuminance: 255,
          dominantChange: 'brighter',
          currentOverlayMatches: [
            {
              ref: 'e1',
              label: 'Continue',
              rect: { x: 1, y: 2, width: 3, height: 4 },
              regionCoveragePercentage: 12,
            },
          ],
        },
      ],
    }),
  );
  assert.match(text, /✗ 5% pixels differ/);
  assert.match(text, /Diff image:/);
  assert.match(text, /Current overlay:/);
  assert.match(text, /diff\.current-overlay\.png \(1 refs\)/);
  assert.match(text, /500 different \/ 10000 total pixels/);
  assert.match(text, /Changed regions:/);
  assert.match(text, /1\. x=10 y=20 100x40, 70% of diff/);
  assert.match(text, /overlaps @e1 "Continue", 12% of region/);
  assert.equal(text.includes('\u001b['), false);
});

test('formatScreenshotDiffText renders dimension mismatch', () => {
  const text = withNoColor(() =>
    formatScreenshotDiffText({
      match: false,
      differentPixels: 100,
      totalPixels: 100,
      mismatchPercentage: 100,
      dimensionMismatch: {
        expected: { width: 1170, height: 2532 },
        actual: { width: 1080, height: 1920 },
      },
    }),
  );
  assert.match(text, /✗ Screenshots have different dimensions/);
  assert.match(text, /expected 1170x2532/);
  assert.match(text, /got 1080x1920/);
  assert.equal(text.includes('different /'), false);
});

test('formatScreenshotDiffText renders diff path relative to cwd', () => {
  const cwd = process.cwd();
  const text = withNoColor(() =>
    formatScreenshotDiffText({
      match: false,
      differentPixels: 10,
      totalPixels: 100,
      mismatchPercentage: 10,
      diffPath: `${cwd}/diff.png`,
    }),
  );
  assert.match(text, /\.\/diff\.png/);
  assert.equal(text.includes(cwd), false);
});

test('formatScreenshotDiffText keeps absolute diff path outside cwd', () => {
  const cwd = process.cwd();
  const parentDir = path.dirname(cwd);
  const siblingDir = path.join(parentDir, `${path.basename(cwd)}-sibling`);
  const diffPath = path.join(siblingDir, 'diff.png');
  const text = withNoColor(() =>
    formatScreenshotDiffText({
      match: false,
      differentPixels: 10,
      totalPixels: 100,
      mismatchPercentage: 10,
      diffPath,
    }),
  );
  assert.match(text, new RegExp(diffPath.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)));
  assert.equal(text.includes('./'), false);
});

test('formatScreenshotDiffText uses ANSI colors when enabled', () => {
  const text = withColor(() =>
    formatScreenshotDiffText({
      match: false,
      differentPixels: 10,
      totalPixels: 100,
      mismatchPercentage: 10,
      diffPath: '/tmp/diff.png',
    }),
  );
  assert.equal(text.includes('\u001b[31m'), true);
  assert.equal(text.includes('\u001b[32m'), true);
  assert.equal(text.includes('\u001b[2m'), true);
});

test('formatScreenshotDiffText does not show diff path when images match', () => {
  const text = withNoColor(() =>
    formatScreenshotDiffText({
      match: true,
      differentPixels: 0,
      totalPixels: 100,
      mismatchPercentage: 0,
      diffPath: '/tmp/diff.png',
    }),
  );
  assert.equal(text.includes('Diff image'), false);
  assert.equal(text.includes('diff.png'), false);
});

function withColor<T>(run: () => T): T {
  const originalForceColor = process.env.FORCE_COLOR;
  const originalNoColor = process.env.NO_COLOR;
  process.env.FORCE_COLOR = '1';
  delete process.env.NO_COLOR;
  try {
    return run();
  } finally {
    if (typeof originalForceColor === 'string') process.env.FORCE_COLOR = originalForceColor;
    else delete process.env.FORCE_COLOR;
    if (typeof originalNoColor === 'string') process.env.NO_COLOR = originalNoColor;
    else delete process.env.NO_COLOR;
  }
}
