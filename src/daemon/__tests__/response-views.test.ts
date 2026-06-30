import { test, expect } from 'vitest';
import { RESPONSE_VIEWS } from '../response-views.ts';
import type { DaemonResponseData } from '../types.ts';

const snapshotView = RESPONSE_VIEWS.snapshot;
const screenshotView = RESPONSE_VIEWS.screenshot;

const SNAPSHOT_DATA: DaemonResponseData = {
  nodes: [
    { ref: 'e1', hittable: true, label: 'Login' },
    { ref: 'e2', hittable: false, label: 'Heading' }, // not hittable → excluded
    { ref: 'e3', hittable: true, interactionBlocked: 'covered', label: 'Hidden' }, // occluded → excluded
    { ref: 'e4', hittable: true, value: 'from-value' }, // label falls back to value
  ],
  truncated: false,
  visibility: { partial: false, visibleNodeCount: 4, totalNodeCount: 4, reasons: [] },
  snapshotQuality: { state: 'healthy', backend: 'tree' },
  appName: 'Demo', // a non-cheap field that the digest intentionally drops
};

test('snapshot view is registered', () => {
  expect(typeof snapshotView).toBe('function');
});

test('digest collapses the node tree to count + actionable refs + cheap signals', () => {
  const digest = snapshotView!(SNAPSHOT_DATA, 'digest');
  expect(digest).toEqual({
    nodeCount: 4,
    refs: [
      { ref: 'e1', label: 'Login' },
      { ref: 'e4', label: 'from-value' },
    ],
    truncated: false,
    visibility: { partial: false, visibleNodeCount: 4, totalNodeCount: 4, reasons: [] },
    snapshotQuality: { state: 'healthy', backend: 'tree' },
  });
  // The full node tree (the token sink) and non-cheap fields are dropped.
  expect('nodes' in digest).toBe(false);
  expect('appName' in digest).toBe(false);
});

test('default and full return today’s shape unchanged (same reference)', () => {
  expect(snapshotView!(SNAPSHOT_DATA, 'default')).toBe(SNAPSHOT_DATA);
  expect(snapshotView!(SNAPSHOT_DATA, 'full')).toBe(SNAPSHOT_DATA);
});

test('digest tolerates missing/empty node trees', () => {
  const digest = snapshotView!({ truncated: true }, 'digest');
  expect(digest).toMatchObject({ nodeCount: 0, refs: [], truncated: true });
});

const overlayRef = (ref: string, label: string | undefined) => ({
  ref,
  ...(label !== undefined ? { label } : {}),
  rect: { x: 0, y: 0, width: 40, height: 20 },
  overlayRect: { x: 0, y: 0, width: 100, height: 50 },
  center: { x: 50, y: 25 },
});

const SCREENSHOT_DATA: DaemonResponseData = {
  path: '/tmp/agent-device-screenshot-xyz/screenshot.png',
  overlayRefs: [
    overlayRef('e1', 'Continue'),
    overlayRef('e2', undefined), // label omitted → stays undefined in the digest
  ],
  artifacts: [{ field: 'path', artifactId: 'art-1', fileName: 'screenshot.png' }], // cheap retrieval handle — preserved
};

test('screenshot view is registered', () => {
  expect(typeof screenshotView).toBe('function');
});

test('digest collapses overlay geometry to count + leveled refs, keeps cheap fields', () => {
  const digest = screenshotView!(SCREENSHOT_DATA, 'digest');
  expect(digest).toEqual({
    path: '/tmp/agent-device-screenshot-xyz/screenshot.png',
    overlayCount: 2,
    overlayRefs: [
      { ref: 'e1', label: 'Continue' },
      { ref: 'e2', label: undefined },
    ],
    artifacts: [{ field: 'path', artifactId: 'art-1', fileName: 'screenshot.png' }],
  });
  // The per-overlay geometry (the token sink) is dropped from every ref.
  expect(digest.overlayRefs).not.toContainEqual(
    expect.objectContaining({ rect: expect.anything() }),
  );
});

test('digest caps the overlay list at 12 while counting them all', () => {
  const overlayRefs = Array.from({ length: 20 }, (_, i) => overlayRef(`e${i + 1}`, `L${i + 1}`));
  const digest = screenshotView!({ path: '/tmp/s.png', overlayRefs }, 'digest');
  expect(digest.overlayCount).toBe(20);
  expect(Array.isArray(digest.overlayRefs) && digest.overlayRefs).toHaveLength(12);
});

test('screenshot default and full return today’s shape unchanged (same reference)', () => {
  expect(screenshotView!(SCREENSHOT_DATA, 'default')).toBe(SCREENSHOT_DATA);
  expect(screenshotView!(SCREENSHOT_DATA, 'full')).toBe(SCREENSHOT_DATA);
});

test('screenshot digest tolerates a path-only result with no overlay refs', () => {
  const digest = screenshotView!({ path: '/tmp/s.png' }, 'digest');
  expect(digest).toEqual({ path: '/tmp/s.png', overlayCount: 0, overlayRefs: [] });
});
