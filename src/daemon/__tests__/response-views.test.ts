import { test, expect } from 'vitest';
import { RESPONSE_VIEWS } from '../response-views.ts';
import type { DaemonResponseData } from '../types.ts';

const snapshotView = RESPONSE_VIEWS.snapshot;

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
