import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceBackend } from '@agent-device/contracts/backend';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
import type { PreresolvedInteractionTarget } from '@agent-device/contracts/interaction';
import type { Point, SnapshotState } from '@agent-device/kernel/snapshot';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { createMemorySessionStore } from '../../../command-runtime/runtime-factory.ts';
import { createLocalArtifactAdapter } from '../../../io.ts';
import { createAgentDevice } from '../../../runtime.ts';
import { ref } from './selector-read-utils.ts';

// #1654: a mutating `find` hands the leaf the node it already resolved. The leaf acts on that node
// and does not look the `@ref` up a second time, so the point it dispatches at is the carried
// node's, whatever the stored session tree now holds under the same ref.

const APPLICATION = {
  index: 0,
  type: 'Application',
  rect: { x: 0, y: 0, width: 390, height: 844 },
};

function treeWithButton(
  label: string,
  rect: { x: number; y: number; width: number; height: number },
) {
  return makeSnapshotState([
    APPLICATION,
    {
      index: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeButton',
      label,
      rect,
      enabled: true,
      hittable: true,
    },
  ]);
}

const SAVE_TREE = treeWithButton('Save', { x: 300, y: 500, width: 20, height: 20 });
const SAVE_CENTER: Point = { x: 310, y: 510 };

/** The same ref body names a different element in the tree the session stores. */
const DIVERGED_TREE = treeWithButton('Delete', { x: 10, y: 700, width: 100, height: 40 });

function carriedSave(): PreresolvedInteractionTarget {
  return { ref: '@e2', node: SAVE_TREE.nodes[1]!, tree: { nodes: SAVE_TREE.nodes } };
}

function createDevice(stored: SnapshotState) {
  const taps: Point[] = [];
  const fills: Array<{ point: Point; text: string }> = [];
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () => ({ snapshot: stored }),
      tap: async (_context, point) => {
        taps.push(point);
        return {};
      },
      fill: async (_context, point, text) => {
        fills.push({ point, text });
        return {};
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot: stored }]),
    policy: localCommandPolicy(),
  });
  return { device, taps, fills };
}

test('press acts on the carried node of a mutating find', async () => {
  const { device, taps } = createDevice(SAVE_TREE);

  await device.interactions.press(ref('@e2'), {
    session: 'default',
    preresolvedTarget: carriedSave(),
  });

  assert.deepEqual(taps, [SAVE_CENTER]);
});

test('fill acts on the carried node of a mutating find', async () => {
  const { device, fills } = createDevice(SAVE_TREE);

  await device.interactions.fill(ref('@e2'), 'hello', {
    session: 'default',
    preresolvedTarget: carriedSave(),
  });

  assert.deepEqual(fills, [{ point: SAVE_CENTER, text: 'hello' }]);
});

test('a stored tree that advanced past the find capture cannot retarget press', async () => {
  const { device, taps } = createDevice(DIVERGED_TREE);

  await device.interactions.press(ref('@e2'), {
    session: 'default',
    preresolvedTarget: carriedSave(),
  });

  assert.deepEqual(taps, [SAVE_CENTER]);
});

test('a stored tree that advanced past the find capture cannot retarget fill', async () => {
  const { device, fills } = createDevice(DIVERGED_TREE);

  await device.interactions.fill(ref('@e2'), 'hello', {
    session: 'default',
    preresolvedTarget: carriedSave(),
  });

  assert.deepEqual(fills, [{ point: SAVE_CENTER, text: 'hello' }]);
});
