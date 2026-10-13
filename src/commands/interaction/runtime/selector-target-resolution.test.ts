import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { selector } from './selector-read-utils.ts';
import { createInteractionDevice } from './__tests__/test-utils/index.ts';

test('a selector press refuses a miss after one interactive and full capture attempt', async () => {
  let captures = 0;
  let taps = 0;
  const device = createInteractionDevice(makeSnapshotState([]), {
    captureSnapshot: async () => {
      captures += 1;
      return { snapshot: makeSnapshotState([]) };
    },
    tap: async () => {
      taps += 1;
    },
  });

  await assert.rejects(
    () => device.interactions.press(selector('label=Continue'), { session: 'default' }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.reason, 'selector_not_found');
      assert.equal(error.details?.dispatched, 'no');
      return true;
    },
  );
  assert.equal(captures, 2);
  assert.equal(taps, 0);
});

test('an unreadable selector capture fails with its content-quality reason without retrying', async () => {
  let captures = 0;
  const device = createInteractionDevice(makeSnapshotState([]), {
    captureSnapshot: async () => {
      captures += 1;
      throw new AppError('COMMAND_FAILED', 'Android snapshot has no readable app content', {
        androidSnapshotHelperFailureReason: 'system-window-only',
      });
    },
  });

  await assert.rejects(
    () => device.interactions.press(selector('label=Continue'), { session: 'default' }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.androidSnapshotHelperFailureReason, 'system-window-only');
      assert.notEqual(error.details?.reason, 'selector_not_found');
      return true;
    },
  );
  assert.equal(captures, 1);
});
