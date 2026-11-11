import { expect, test } from 'vitest';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import {
  readSnapshotNativePressTargets,
  copySnapshotNativePressTargets,
} from '@agent-device/contracts/snapshot-private-evidence';
import { presentIosSnapshotAcquisition } from '../ios-snapshot-runtime.ts';
import { buildSnapshotState } from '../../snapshot-state.ts';

const screen = { x: 0, y: 0, width: 390, height: 844 };
const full = { x: 16, y: 100, width: 350, height: 100 };
const nodes: RawSnapshotNode[] = [
  { index: 0, depth: 0, type: 'Application', rect: screen },
  {
    index: 1,
    parentIndex: 0,
    depth: 1,
    type: 'ScrollView',
    rect: { x: 0, y: 150, width: 390, height: 100 },
  },
  { index: 2, parentIndex: 1, depth: 2, type: 'Cell', label: 'General', rect: full },
  { index: 3, parentIndex: 2, depth: 3, type: 'Other', label: 'General', rect: full },
  {
    index: 4,
    parentIndex: 3,
    depth: 4,
    type: 'Button',
    label: 'General',
    identifier: 'com.apple.settings.general',
    rect: full,
  },
  { index: 5, parentIndex: 1, depth: 2, type: 'TextField', value: 'Hint', rect: full },
];

// Source/native identity must survive geometric and semantic presentation. Comparing public Cell
// id/rect with raw XCTest would miss a ready Settings row; prior guard fixtures never presented it.
for (const raw of [false, true]) {
  test(`native source binding survives clipping and promoted identifiers without leaking: raw=${raw}`, () => {
    const captured = presentIosSnapshotAcquisition(
      {
        stage: 'acquired',
        acquisition: {
          producer: 'simulator-ax-bridge',
          intent: 'full',
          nodes: nodes.map((node, index) => ({
            ...node,
            nativePressTarget: {
              type: [2, 46, 75, 1, 9, 49][index]!,
              label: node.label,
              identifier: node.identifier,
              value: node.type === 'TextField' ? undefined : node.value,
              rect: node.rect!,
            },
          })),
          truncated: false,
          viewport: { kind: 'reported', rect: screen },
          lineage: { targetId: 'sim-1' },
          residue: [],
        },
      },
      { interactiveOnly: true, raw },
    );
    const snapshot = buildSnapshotState(captured, {
      snapshotInteractiveOnly: true,
      snapshotRaw: raw,
    });
    const cell = snapshot.nodes.find((node) => node.type === 'Cell')!;
    if (!raw) {
      expect(cell.identifier).toBe('com.apple.settings.general');
      expect(cell.rect).toEqual({ x: 16, y: 150, width: 350, height: 50 });
    }
    expect(readSnapshotNativePressTargets(snapshot.nodes)?.get(cell.index)).toEqual({
      type: 75,
      label: 'General',
      identifier: undefined,
      value: undefined,
      rect: full,
    });
    const field = snapshot.nodes.find((node) => node.type === 'TextField')!;
    expect(field.value).toBe('Hint');
    expect(readSnapshotNativePressTargets(snapshot.nodes)?.get(field.index)).toMatchObject({
      type: 49,
      value: undefined,
      rect: full,
    });
    const cloned = copySnapshotNativePressTargets(snapshot.nodes, structuredClone(snapshot.nodes));
    expect(readSnapshotNativePressTargets(cloned)?.get(field.index)).toEqual(
      readSnapshotNativePressTargets(snapshot.nodes)?.get(field.index),
    );
    expect(JSON.stringify(snapshot)).not.toContain('nativePressTarget');
  });
}

test('an acquired provider without native provenance does not gain readiness evidence', () => {
  const captured = presentIosSnapshotAcquisition({
    stage: 'acquired',
    acquisition: {
      producer: 'simulator-ax-bridge',
      intent: 'full',
      truncated: false,
      nodes: [
        nodes[0]!,
        {
          index: 1,
          parentIndex: 0,
          depth: 1,
          type: 'SecureTextField',
          value: 'private-secret',
          rect: full,
        },
      ],
      viewport: { kind: 'reported', rect: screen },
      lineage: {},
      residue: [],
    },
  });
  const snapshot = buildSnapshotState(captured, {});
  expect(readSnapshotNativePressTargets(snapshot.nodes)?.size ?? 0).toBe(0);
});
