import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Point, RawSnapshotNode, SnapshotNode } from '@agent-device/kernel/snapshot';
import type { PreresolvedInteractionTarget } from '@agent-device/contracts/interaction';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { ref } from './selector-read-utils.ts';
import { createLocalArtifactAdapter } from '../../../io.ts';
import { createMemorySessionStore } from '../../../command-runtime/runtime-factory.ts';
import { createAgentDevice } from '../../../runtime.ts';

// #1654: a mutating `find` hands the interaction leaf the node it already resolved, so the leaf
// adopts that node instead of resolving the same `@ref` a second time, while the shared guards
// keep running on it.

const SESSION_TREE: RawSnapshotNode[] = [
  { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
  {
    index: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeButton',
    label: 'Continue',
    rect: { x: 10, y: 20, width: 100, height: 40 },
    enabled: true,
    hittable: true,
  },
  {
    index: 2,
    parentIndex: 0,
    type: 'XCUIElementTypeButton',
    label: 'Cancel',
    rect: { x: 10, y: 80, width: 100, height: 40 },
    enabled: true,
    hittable: true,
  },
];

// The tree a mutating `find` matched against, deliberately NOT the tree stored on the session.
// `@e2` names the "Continue" button in both trees, but at a distinctive point here and at (60, 40)
// in the session tree, so the tap coordinates say which tree the leaf actually resolved against.
function findResolved(): PreresolvedInteractionTarget & { node: SnapshotNode } {
  const nodes = makeSnapshotState([
    { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
    {
      index: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeButton',
      label: 'Continue',
      rect: { x: 300, y: 500, width: 20, height: 20 },
      enabled: true,
      hittable: true,
    },
  ]).nodes;
  return { ref: '@e2', node: nodes[1]!, tree: { nodes } };
}

function deviceWithSessionTree(snapshot: ReturnType<typeof makeSnapshotState> | undefined) {
  const taps: Point[] = [];
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () => ({ snapshot: snapshot ?? makeSnapshotState([]) }),
      tap: async (_context, point) => {
        taps.push(point);
      },
    },
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot }]),
    policy: localCommandPolicy(),
  });
  return { device, taps };
}

test('runtime click acts on the node find resolved, not a re-resolved @ref', async () => {
  const { device, taps } = deviceWithSessionTree(makeSnapshotState(SESSION_TREE));

  const result = await device.interactions.click(ref('@e2'), {
    session: 'default',
    preresolvedTarget: findResolved(),
  });

  assert.equal(result.kind, 'ref');
  // find's node (300,500,20,20) -> (310, 510). A second resolution would read @e2 out of the
  // SESSION tree instead and tap (60, 40).
  assert.deepEqual(taps, [{ x: 310, y: 510 }]);
});

test('runtime click without the resolved-target payload still resolves @ref from the session tree', async () => {
  const { device, taps } = deviceWithSessionTree(makeSnapshotState(SESSION_TREE));

  await device.interactions.click(ref('@e2'), { session: 'default' });

  // The ordinary ref path is untouched: @e2 is "Continue" at (10,20,100,40).
  assert.deepEqual(taps, [{ x: 60, y: 40 }]);
});

test('runtime click with a resolved-target payload performs no ref lookup at all', async () => {
  // This synthetic session has no stored snapshot, so any second resolution necessarily fails
  // ("Ref @e2 not found or has no bounds"). Production find normally stores its capture; this
  // proves lookup absence without claiming that missing state occurs.
  const { device, taps } = deviceWithSessionTree(undefined);

  await assert.rejects(() => device.interactions.click(ref('@e2'), { session: 'default' }));
  assert.deepEqual(taps, []);

  await device.interactions.click(ref('@e2'), {
    session: 'default',
    preresolvedTarget: findResolved(),
  });

  assert.deepEqual(taps, [{ x: 310, y: 510 }]);
});

test('runtime click refuses a resolved-target payload whose ref provenance disagrees', async () => {
  const { device, taps } = deviceWithSessionTree(makeSnapshotState(SESSION_TREE));

  await assert.rejects(
    () =>
      device.interactions.click(ref('@e2'), {
        session: 'default',
        preresolvedTarget: { ...findResolved(), ref: '@e9' },
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
      assert.match(error.message, /provenance does not match/);
      return true;
    },
  );
  assert.deepEqual(taps, []);
});

test('runtime click keeps the shared guards running on a pre-resolved node', async () => {
  // The pre-resolution replaces the lookup, not the guarantees: an occluded node is still refused,
  // at the same ADR 0011 `runtime-ref` occlusion cell.
  const { device, taps } = deviceWithSessionTree(makeSnapshotState(SESSION_TREE));
  const resolved = findResolved();
  const blocked: SnapshotNode = {
    ...resolved.node,
    interactionBlocked: 'covered',
  };

  await assert.rejects(
    () =>
      device.interactions.click(ref('@e2'), {
        session: 'default',
        preresolvedTarget: {
          ref: '@e2',
          node: blocked,
          tree: { nodes: [resolved.tree.nodes[0]!, blocked] },
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
      assert.match(error.message, /covered by another visible element/);
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'target_covered');
      assert.equal(details?.dispatched, 'no');
      return true;
    },
  );
  assert.deepEqual(taps, []);
});
