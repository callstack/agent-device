import { expect, test } from 'vitest';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { surfaceScopedNodes } from './snapshot-baseline.ts';

const nodes = [{ index: 0, type: 'Application', ref: 'e1' }];

/**
 * #3565 and #2438: this is the one mint both settle routes take their baseline from, so every fact a
 * capture established about what it read has to leave here with the nodes. A baseline that lost the
 * presented-surface fact would read to #1831's dismissal confirmation as "no producer spoke" instead of
 * the reading the capture actually took.
 */
test('the mint carries the presented-surface fact beside the nodes', () => {
  for (const presentedSurface of ['presented', 'absent', 'unknown'] as const) {
    expect(surfaceScopedNodes(snapshot({ presentedSurface }))).toEqual({
      nodes,
      presentedSurface,
    });
  }
});

test('the mint carries no presented surface a capture never read', () => {
  expect(surfaceScopedNodes(snapshot({}))).toEqual({ nodes });
});

test('the mint carries the system surface the nodes describe', () => {
  expect(
    surfaceScopedNodes(snapshot({ iosSystemSurfaceBundleId: 'com.apple.SafariViewService' })),
  ).toEqual({ nodes, surfaceBundleId: 'com.apple.SafariViewService' });
});

test('a session with no stored snapshot still mints an empty baseline', () => {
  expect(surfaceScopedNodes(undefined)).toEqual({ nodes: [] });
});

function snapshot(fields: Partial<SnapshotState>): SnapshotState {
  return { nodes, createdAt: 0, presentationKey: '', ...fields } as SnapshotState;
}
