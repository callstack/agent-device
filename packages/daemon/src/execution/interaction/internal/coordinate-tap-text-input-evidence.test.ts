import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import type { CoordinateTapTextInputEvidence } from '@agent-device/contracts/interactor-types';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { presentIosSnapshotAcquisition } from '@agent-device/capture-kit/ios-snapshot-runtime';
import { buildSnapshotState } from '@agent-device/capture-kit/snapshot-state';
import { buildCoordinateTapTextInputEvidence } from './coordinate-tap-text-input-evidence.ts';

type Fixture = {
  name: string;
  nodes: Omit<RawSnapshotNode, 'index'>[];
  point: { x: number; y: number };
  appBundleId: string;
  source?: CoordinateTapTextInputEvidence['source'];
  truncated?: boolean;
  expectedEvidence: CoordinateTapTextInputEvidence | null;
};
const cases: Fixture[] = JSON.parse(
  readFileSync(
    new URL('../../../../../../contracts/fixtures/coordinate-tap-text-input.json', import.meta.url),
    'utf8',
  ),
);

test.each(cases)('$name preserves acquired input geometry through presentation', (fixture) => {
  const screen = { x: 0, y: 0, width: 400, height: 874 };
  const presented = presentIosSnapshotAcquisition(
    {
      stage: 'acquired',
      acquisition: {
        producer: 'simulator-ax-bridge',
        intent: 'full',
        nodes: [
          { index: 0, type: 'Application', rect: screen },
          ...fixture.nodes.map((node, index) => ({
            ...node,
            index: index + 1,
            parentIndex: node.parentIndex ?? 0,
            depth: node.depth ?? 1,
          })),
        ],
        truncated: fixture.truncated ?? false,
        viewport: { kind: 'reported', rect: screen },
        lineage: { targetId: 'sim-1', generation: 'g1' },
        residue: [],
      },
    },
    { interactiveOnly: true },
  );
  const snapshot = buildSnapshotState(presented, { snapshotInteractiveOnly: true });
  const result = buildCoordinateTapTextInputEvidence(
    snapshot,
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
