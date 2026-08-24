import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { ScreenshotOverlayRef } from '@agent-device/kernel/snapshot';
import {
  snapshotTimeoutCaptureFailed,
  snapshotTimeoutEvidenceOverlayCounts,
  snapshotTimeoutEvidenceOverlayFailed,
  snapshotTimeoutEvidenceWithOverlayRefs,
  snapshotTimeoutEvidenceWithoutOverlaySource,
  type SnapshotTimeoutEvidence,
} from './snapshot-timeout-evidence.ts';

function overlayRef(ref: string): ScreenshotOverlayRef {
  return {
    ref,
    label: ref,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    overlayRect: { x: 0, y: 0, width: 10, height: 10 },
    center: { x: 5, y: 5 },
  };
}

test('a failed capture publishes no path and no overlay claim', () => {
  const evidence = snapshotTimeoutCaptureFailed('adb screencap exited 1');
  assert.deepEqual(evidence, { captureFailed: true, error: 'adb screencap exited 1' });
  assert.deepEqual(snapshotTimeoutEvidenceOverlayCounts(evidence), {
    overlayRefCount: undefined,
    overlayRefsAnnotated: undefined,
  });
});

test('a capture with no stored observation still discloses that refs were requested', () => {
  const evidence = snapshotTimeoutEvidenceWithoutOverlaySource('/tmp/shot.png');
  assert.deepEqual(evidence, {
    path: '/tmp/shot.png',
    overlayRefsRequested: true,
    overlayRefsAnnotated: false,
    overlayRefSource: 'unavailable',
    overlayRefCount: 0,
  });
});

test('the union cannot express an annotated capture with no refs', () => {
  // Type-level half of the invariant: the annotated arm carries a non-empty tuple, so this
  // literal is not assignable. `@ts-expect-error` fails the build if it ever becomes valid.
  // @ts-expect-error annotated:true requires at least one overlay ref
  const contradiction: SnapshotTimeoutEvidence = {
    path: '/tmp/shot.png',
    overlayRefsRequested: true,
    overlayRefSource: 'session-snapshot',
    overlayRefsAnnotated: true,
    overlayRefCount: 0,
    overlayRefs: [],
  };
  assert.ok(contradiction);
});

test('an empty ref list is a capture that was not annotated, not an annotated one', () => {
  const none = snapshotTimeoutEvidenceWithOverlayRefs('/tmp/shot.png', []);
  const some = snapshotTimeoutEvidenceWithOverlayRefs('/tmp/shot.png', [overlayRef('e1')]);
  assert.deepEqual(snapshotTimeoutEvidenceOverlayCounts(none), {
    overlayRefCount: 0,
    overlayRefsAnnotated: false,
  });
  assert.deepEqual(snapshotTimeoutEvidenceOverlayCounts(some), {
    overlayRefCount: 1,
    overlayRefsAnnotated: true,
  });
});

test('a failed annotation keeps the screenshot and names why the refs are missing', () => {
  const evidence = snapshotTimeoutEvidenceOverlayFailed('/tmp/shot.png', 'png decode failed');
  assert.deepEqual(evidence, {
    path: '/tmp/shot.png',
    overlayRefsRequested: true,
    overlayRefsAnnotated: false,
    overlayRefSource: 'session-snapshot',
    overlayRefCount: 0,
    overlayAnnotationError: 'png decode failed',
  });
});
