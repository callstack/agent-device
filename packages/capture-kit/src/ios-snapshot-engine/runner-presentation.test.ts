import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  IosSnapshotInput,
  IosSnapshotRequest,
  IosSnapshotValidationFacts,
} from '@agent-device/contracts/ios-snapshot';
import {
  buildIosSnapshotPresentationKey,
  createIosSnapshotRequest,
} from '@agent-device/capture-kit/ios-snapshot-planning';
import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import { presentIosSnapshot } from './index.ts';

const viewport: Rect = { x: 0, y: 0, width: 402, height: 874 };

test('runner presentation clips rows to a scroll viewport derived from its indicator', () => {
  const request = createIosSnapshotRequest({ interactiveOnly: true });
  const nodes = runnerNodes();
  const result = presentIosSnapshot(runnerInput(request, nodes), request);
  const screenTime = result.nodes.find((node) => node.label === 'Screen Time');

  assert.deepEqual(screenTime?.rect, {
    x: 16,
    y: 796.3333333333334,
    width: 370,
    height: 15.666666666666629,
  });
  assert.equal(screenTime?.hittable, true);
  assert.equal(
    result.nodes.some((node) => node.label === 'Offscreen'),
    false,
  );
});

function runnerInput(request: IosSnapshotRequest, nodes: RawSnapshotNode[]): IosSnapshotInput {
  return {
    stage: 'presented',
    presentation: {
      producer: 'apple-runner',
      intent: 'full',
      payload: { nodes, truncated: false },
    },
    validation: validationFacts(request),
  };
}

function validationFacts(request: IosSnapshotRequest): IosSnapshotValidationFacts {
  return {
    presentationKey: buildIosSnapshotPresentationKey(request),
    viewport: { kind: 'reported', rect: viewport },
    hittability: { kind: 'available' },
    lineage: { targetId: 'runner-target', generation: 'runner-generation' },
    residue: [],
  };
}

function runnerNodes(): RawSnapshotNode[] {
  return [
    runnerNode(0, 'Application', 'Settings', viewport),
    runnerNode(1, 'Other', undefined, viewport, 0, 1),
    runnerNode(2, 'CollectionView', 'Settings', viewport, 1, 2),
    runnerNode(
      3,
      'Cell',
      'Screen Time',
      { x: 16, y: 796.3333333333334, width: 370, height: 52 },
      2,
      3,
    ),
    runnerNode(
      4,
      'Other',
      'Screen Time',
      { x: 16, y: 796.3333333333334, width: 370, height: 52 },
      3,
      4,
    ),
    runnerNode(
      5,
      'Button',
      'Screen Time',
      { x: 16, y: 796.3333333333334, width: 370, height: 52 },
      4,
      5,
    ),
    runnerNode(
      6,
      'StaticText',
      'Screen Time',
      { x: 30, y: 808.3333, width: 137.3333, height: 28 },
      5,
      6,
    ),
    runnerNode(7, 'Image', undefined, { x: 30, y: 808.3333333333334, width: 28, height: 28 }, 5, 6),
    runnerNode(8, 'Cell', 'Offscreen', { x: 16, y: 820, width: 370, height: 52 }, 2, 3),
    runnerNode(9, 'Button', 'Offscreen', { x: 16, y: 820, width: 370, height: 52 }, 8, 4),
    {
      ...runnerNode(
        10,
        'Other',
        'Vertical scroll bar, 2 pages',
        {
          x: 369,
          y: 116,
          width: 30,
          height: 696,
        },
        2,
        3,
      ),
      value: '0%',
    },
  ];
}

function runnerNode(
  index: number,
  type: string,
  label: string | undefined,
  rect: Rect,
  parentIndex?: number,
  depth = parentIndex === undefined ? 0 : 1,
): RawSnapshotNode {
  return {
    index,
    type,
    ...(label ? { label } : {}),
    rect,
    enabled: true,
    hittable: true,
    depth,
    ...(parentIndex === undefined ? {} : { parentIndex }),
  };
}
