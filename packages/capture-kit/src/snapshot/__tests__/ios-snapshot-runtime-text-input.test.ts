import { expect, test } from 'vitest';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import type { IosAcquisitionResidue } from '@agent-device/contracts/ios-snapshot';
import { readSnapshotTextInputGeometry } from '@agent-device/contracts/capture';
import { presentIosSnapshotAcquisition } from '../ios-snapshot-runtime.ts';
import { buildSnapshotState } from '../../snapshot-state.ts';

const screen = { x: 0, y: 0, width: 390, height: 844 };
const field = { x: 0, y: 100, width: 300, height: 100 };
const nodes: RawSnapshotNode[] = [
  { index: 0, depth: 0, type: 'Application', rect: screen },
  { index: 1, parentIndex: 0, depth: 1, type: 'Cell', rect: field, hittable: true },
  {
    index: 2,
    parentIndex: 1,
    depth: 2,
    type: 'TextView',
    label: 'Message',
    rect: field,
    editable: true,
    enabled: true,
    hittable: true,
  },
];

function capture(
  truncated: boolean | undefined,
  residue: readonly IosAcquisitionResidue[] = [],
  options = { interactiveOnly: true },
) {
  return presentIosSnapshotAcquisition(
    {
      stage: 'acquired',
      acquisition: {
        producer: 'simulator-ax-bridge',
        intent: 'full',
        nodes,
        truncated,
        viewport: { kind: 'reported', rect: screen },
        lineage: { targetId: 'sim-1', generation: 'g1' },
        residue,
      },
    },
    options,
  );
}

test('row label promotion preserves the suppressed text view as input geometry', () => {
  const presented = capture(false);
  expect(presented.nodes?.some((node) => node.type === 'TextView')).toBe(false);
  expect(presented.nodes?.find((node) => node.type === 'Cell')?.label).toBe('Message');
  const snapshot = buildSnapshotState(presented, { snapshotInteractiveOnly: true });
  expect(readSnapshotTextInputGeometry(snapshot.nodes)).toEqual({ rects: [field] });
  expect(JSON.stringify(snapshot)).not.toContain('textInputGeometry');
});

test.each([
  { truncated: true, residue: [] },
  { truncated: undefined, residue: [] },
  { truncated: false, residue: [{ kind: 'provider-pruned', fields: ['nodes'] }] },
  { truncated: false, residue: [{ kind: 'unavailable-fact', fact: 'acquisition-depth' }] },
] as const)(
  'incomplete acquisition cannot establish negative input evidence: $truncated/$residue',
  ({ truncated, residue }) => {
    const presented = capture(truncated, residue);
    expect(readSnapshotTextInputGeometry(presented.nodes)).toBeUndefined();
  },
);
