import { expect, test } from 'vitest';
import type { SnapshotState } from '@agent-device/contracts/snapshot-model';
import type { SurfaceScopedNodes } from '@agent-device/contracts/interaction';
import { postActionBaseline, surfaceScopedNodes } from './snapshot-baseline.ts';

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

test('the mint carries the presentation the capture read', () => {
  expect(surfaceScopedNodes(snapshot({ presentation: { interactiveOnly: true } }))).toEqual({
    nodes,
    presentation: { interactiveOnly: true },
  });
});

const INTERACTIVE = { interactiveOnly: true };
const FULL = {};
const frame = (presentation: SurfaceScopedNodes['presentation']) => tree('frame', presentation);

// #4486: a settle diff compares one view, and the agent's view is its ref frame's presentation.
test.each([
  ['interactive frame, interactive candidate', INTERACTIVE, INTERACTIVE, 'candidate'],
  ['interactive frame, full candidate', INTERACTIVE, FULL, 'frame'],
  ['full frame, interactive candidate', FULL, INTERACTIVE, 'frame'],
  ['full frame, full candidate', FULL, FULL, 'candidate'],
  [
    'interactive frame, scoped interactive candidate',
    INTERACTIVE,
    { interactiveOnly: true, scope: 'Composer' },
    'frame',
  ],
  ['interactive frame, candidate with no recorded view', INTERACTIVE, undefined, 'candidate'],
] as const)(
  '%s: the %s answers',
  async (_case, framePresentation, candidatePresentation, expected) => {
    const baseline = await postActionBaseline({
      frame: frame(framePresentation),
      candidates: [tree('candidate', candidatePresentation)],
    });
    expect(baseline.nodes[0]?.label).toBe(expected);
  },
);

test('without a frame the first non-empty candidate answers, in its own view', async () => {
  const baseline = await postActionBaseline({
    frame: undefined,
    candidates: [undefined, { nodes: [] }, tree('candidate', FULL)],
  });
  expect(baseline).toEqual(tree('candidate', FULL));
  expect(await postActionBaseline({ frame: undefined, candidates: [] })).toEqual({ nodes: [] });
});

function tree(label: string, presentation: SurfaceScopedNodes['presentation']): SurfaceScopedNodes {
  return {
    nodes: [{ index: 0, type: 'Button', label, ref: 'e1' }],
    ...(presentation ? { presentation } : {}),
  };
}

function snapshot(fields: Partial<SnapshotState>): SnapshotState {
  return { nodes, createdAt: 0, presentationKey: '', ...fields } as SnapshotState;
}
