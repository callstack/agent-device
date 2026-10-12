import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';

const { captureAccessibilityTree } = vi.hoisted(() => ({
  captureAccessibilityTree: vi.fn(),
}));

// snapshot.ts consumes the AT-SPI2 bridge seam; fake it rather than a generic exec mock.
vi.mock('../atspi-bridge.ts', () => ({ captureAccessibilityTree }));

import { readLinuxTextAtPoint, snapshotLinux } from '../snapshot.ts';

const mockCapture = vi.mocked(captureAccessibilityTree);

function node(partial: Partial<RawSnapshotNode> & { index: number }): RawSnapshotNode {
  return { type: 'text', ...partial };
}

function captureNodes(nodes: RawSnapshotNode[]): void {
  mockCapture.mockResolvedValue({ nodes, truncated: false, surface: 'desktop' });
}

beforeEach(() => {
  mockCapture.mockReset();
});

test('snapshotLinux maps the app surface to the frontmost app and forwards the signal', async () => {
  const signal = new AbortController().signal;
  captureNodes([]);

  await snapshotLinux('app', signal);

  assert.deepEqual(mockCapture.mock.calls[0], ['frontmost-app', { signal }]);
});

test('snapshotLinux falls back to desktop for the unsupported menubar surface', async () => {
  captureNodes([]);

  await snapshotLinux('menubar');

  assert.equal(mockCapture.mock.calls[0]?.[0], 'desktop');
});

test('readLinuxTextAtPoint prefers the deepest match and the smaller area at equal depth', async () => {
  captureNodes([
    node({
      index: 0,
      depth: 0,
      label: 'window',
      rect: { x: 0, y: 0, width: 200, height: 200 },
    }),
    node({
      index: 1,
      depth: 1,
      label: 'outer-group',
      rect: { x: 10, y: 10, width: 100, height: 100 },
    }),
    node({
      index: 2,
      depth: 1,
      label: 'button',
      rect: { x: 20, y: 20, width: 40, height: 20 },
    }),
    node({
      index: 3,
      depth: 1,
      label: 'elsewhere',
      rect: { x: 150, y: 150, width: 30, height: 30 },
    }),
    node({ index: 4, depth: 2, label: 'no-rect' }),
  ]);

  const text = await readLinuxTextAtPoint(30, 25, 'desktop');

  // Deepest first among equal depths, the narrower rect wins: the 40x20 button, not the 100x100 group.
  assert.equal(text, 'button');
});

test('readLinuxTextAtPoint skips matches without readable text and reads value before label', async () => {
  captureNodes([
    node({
      index: 0,
      depth: 1,
      label: '',
      value: '',
      rect: { x: 0, y: 0, width: 10, height: 10 },
    }),
    node({
      index: 1,
      depth: 0,
      value: 'entry-value',
      label: 'ignored-label',
      rect: { x: 0, y: 0, width: 40, height: 40 },
    }),
  ]);

  assert.equal(await readLinuxTextAtPoint(5, 5, 'desktop'), 'entry-value');
});

test('readLinuxTextAtPoint reads the identifier when value and label are absent', async () => {
  captureNodes([
    node({
      index: 0,
      depth: 0,
      identifier: 'accessibility-id',
      rect: { x: 0, y: 0, width: 10, height: 10 },
    }),
  ]);

  assert.equal(await readLinuxTextAtPoint(5, 5, 'desktop'), 'accessibility-id');
});

test('readLinuxTextAtPoint returns an empty string when no rect covers the point', async () => {
  captureNodes([
    node({
      index: 0,
      depth: 0,
      label: 'far',
      rect: { x: 100, y: 100, width: 10, height: 10 },
    }),
  ]);

  assert.equal(await readLinuxTextAtPoint(0, 0, 'desktop'), '');
});

test('readLinuxTextAtPoint ties depth 0 through rect area when rects are degenerate', async () => {
  // A zero-width or zero-height rect still has area 0 (0 * 10 === 0 * 0), so the pair ties on
  // area and resolves by tree order; and neither rect covers a point one pixel out, so the
  // inclusive-boundary match, not a size fudge, decides whether anything reads at all.
  captureNodes([
    node({ index: 0, depth: 0, label: 'first', rect: { x: 0, y: 0, width: 0, height: 0 } }),
    node({ index: 1, depth: 0, label: 'second', rect: { x: 0, y: 0, width: 0, height: 10 } }),
  ]);

  // Vitest/JS sort is stable, so equal depth and equal area resolve in tree order.
  assert.equal(await readLinuxTextAtPoint(0, 0, 'desktop'), 'first');
  assert.equal(await readLinuxTextAtPoint(1, 1, 'desktop'), '');
});

test('readLinuxTextAtPoint ranks a missing depth as depth 0, in both sort directions', async () => {
  // Two fixtures pin the default to exactly 0. Here `no-depth` ties the depth-0 nodes and loses
  // only on area, so any fallback above 0 (or 1) ranks it deeper than them and it — not
  // `smaller` — would come back from the read.
  captureNodes([
    node({ index: 0, label: 'no-depth', rect: { x: 0, y: 0, width: 100, height: 100 } }),
    node({ index: 1, depth: 0, label: 'root', rect: { x: 0, y: 0, width: 100, height: 100 } }),
    node({ index: 2, depth: 0, label: 'smaller', rect: { x: 0, y: 0, width: 60, height: 60 } }),
  ]);

  assert.equal(await readLinuxTextAtPoint(50, 50, 'desktop'), 'smaller');

  // The complement catches a negative fallback: the missing-depth node carries the smaller
  // area, so depth 0 ranks it first among the depth-0 matches, while any fallback below 0
  // ranks it behind `root` and the read would return `root`.
  captureNodes([
    node({ index: 0, depth: 0, label: 'root', rect: { x: 0, y: 0, width: 100, height: 100 } }),
    node({ index: 1, label: 'no-depth', rect: { x: 0, y: 0, width: 60, height: 60 } }),
  ]);

  assert.equal(await readLinuxTextAtPoint(50, 50, 'desktop'), 'no-depth');
});
