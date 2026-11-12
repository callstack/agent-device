import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { attachSnapshotNodeInteractionBounds } from '@agent-device/kernel/rect-center';
import { buildSnapshotState } from '@agent-device/capture-kit/snapshot-state';
import { createInteractionDevice } from './__tests__/test-utils/index.ts';
import { ref, selector } from './selector-read-utils.ts';

test('selector refuses an overflowed center before backend input', async () => {
  const snapshot = buildSnapshotState(
    {
      backend: 'android',
      producer: 'android-uiautomator',
      nodes: [
        {
          index: 0,
          type: 'Button',
          identifier: 'overflow',
          label: 'Overflow',
          hittable: true,
          rect: { x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 10 },
        },
      ],
    },
    { snapshotRaw: true },
  );
  const calls: unknown[] = [];
  const device = createInteractionDevice(snapshot, {
    platform: 'android',
    tap: async (_context, point) => {
      calls.push(point);
    },
  });
  const observed = await device.capture.snapshot({ session: 'default' });
  const node = observed.nodes.find((entry) => entry.identifier === 'overflow');
  assert.ok(node?.ref);
  await assert.rejects(
    device.interactions.click(selector('id=overflow'), {
      session: 'default',
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.reason, 'target_bounds_invalid');
      assert.equal(error.details?.dispatched, 'no');
      return true;
    },
  );
  assert.deepEqual(calls, []);
});

for (const route of ['ref', 'selector'] as const) {
  for (const covered of [false, true]) {
    test(`${route} honors measured input bounds through raw ingestion and session cloning: covered=${covered}`, async () => {
      const root = { x: 0, y: 0, width: 1080, height: 2400 };
      const bounds = { ...root, height: 2274 };
      const target = attachSnapshotNodeInteractionBounds(
        {
          index: 1,
          depth: 1,
          parentIndex: 0,
          type: 'Button',
          identifier: 'row',
          label: 'Row',
          hittable: true,
          rect: { x: 0, y: covered ? 2305 : 2259, width: 1080, height: covered ? 95 : 131 },
        },
        bounds,
      );
      const snapshot = buildSnapshotState(
        {
          backend: 'android',
          producer: 'android-uiautomator',
          nodes: [{ index: 0, depth: 0, type: 'Application', rect: root }, target],
        },
        { snapshotRaw: true },
      );
      const calls: unknown[] = [];
      const device = createInteractionDevice(snapshot, {
        platform: 'android',
        tap: async (_context, point) => {
          calls.push(point);
        },
      });
      const observed = await device.capture.snapshot({ session: 'default' });
      const node = observed.nodes.find((n) => n.identifier === 'row');
      assert.ok(node?.ref);
      const failure = await device.interactions
        .click(route === 'ref' ? ref(`@${node.ref}`) : selector('id=row'), { session: 'default' })
        .then(
          () => undefined,
          (error) => error,
        );
      if (covered) {
        assert.ok(failure instanceof AppError);
        assert.equal(failure.details?.reason, 'target_bounds_invalid');
        assert.equal(failure.details?.dispatched, 'no');
        assert.deepEqual(calls, []);
      } else {
        assert.equal(failure, undefined);
        assert.deepEqual(calls, [{ x: 540, y: 2267 }]);
      }
    });
  }
}
