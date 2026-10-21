import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import type { CoordinateTapTextInputEvidence } from '@agent-device/contracts/interactor-types';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { buildCoordinateTapTextInputEvidence } from './coordinate-tap-text-input-evidence.ts';

type Fixture = {
  name: string;
  nodes: SnapshotNode[];
  point: { x: number; y: number };
  appBundleId: string;
  source?: CoordinateTapTextInputEvidence['source'];
  truncated?: boolean;
  iosSystemSurfaceBundleId?: string;
  expectedEvidence: CoordinateTapTextInputEvidence | null;
};
const cases: Fixture[] = JSON.parse(
  readFileSync(
    new URL('../../../../../../contracts/fixtures/coordinate-tap-text-input.json', import.meta.url),
    'utf8',
  ),
);

test.each(cases)('$name preserves the typed input rectangles and their target', (fixture) => {
  const result = buildCoordinateTapTextInputEvidence(
    {
      nodes: fixture.nodes,
      createdAt: 1,
      truncated: fixture.truncated,
      iosSystemSurfaceBundleId: fixture.iosSystemSurfaceBundleId,
    },
    fixture.point,
    fixture.appBundleId,
    fixture.source ?? 'selector-capture',
  );
  expect(result ?? null).toEqual(fixture.expectedEvidence);
});

test('missing, empty, sparse, and unbound observations cannot establish exclusion', () => {
  const point = { x: 10, y: 20 };
  expect(
    buildCoordinateTapTextInputEvidence(undefined, point, 'app', 'selector-capture'),
  ).toBeUndefined();
  expect(
    buildCoordinateTapTextInputEvidence(
      { nodes: [], createdAt: 1 },
      point,
      'app',
      'selector-capture',
    ),
  ).toBeUndefined();
  expect(
    buildCoordinateTapTextInputEvidence(
      {
        nodes: [{ index: 0, type: 'Button' }],
        createdAt: 1,
        snapshotQuality: { state: 'sparse', backend: 'tree' },
      },
      point,
      'app',
      'selector-capture',
    ),
  ).toBeUndefined();
  expect(
    buildCoordinateTapTextInputEvidence(
      { nodes: [{ index: 0, type: 'Button' }], createdAt: 1 },
      point,
      undefined,
      'selector-capture',
    ),
  ).toBeUndefined();
});
