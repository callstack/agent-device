import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceBackend, BackendSnapshotResult } from '../../../backend.ts';
import { createLocalArtifactAdapter } from '../../../io.ts';
import {
  createAgentDevice,
  createMemorySessionStore,
  localCommandPolicy,
} from '../../../runtime.ts';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { createFakeClock } from './__tests__/test-utils/index.ts';
import { AppError } from '@agent-device/kernel/errors';

const SELECTOR = 'label="Removed"';

function snapshot(
  label?: string,
  overrides?: Parameters<typeof makeSnapshotState>[1],
): BackendSnapshotResult {
  return {
    snapshot: makeSnapshotState(
      label === undefined
        ? []
        : [{ index: 0, depth: 0, type: 'Button', identifier: 'removed', label }],
      overrides,
    ),
  };
}

function unreadableCapture(): AppError {
  return new AppError('COMMAND_FAILED', 'Android helper returned no readable app content.', {
    androidSnapshotHelperFailureReason: 'empty-helper-output',
  });
}

function absentDevice(
  captures: Array<BackendSnapshotResult | AppError>,
  platform: AgentDeviceBackend['platform'] = 'ios',
) {
  let index = 0;
  return createAgentDevice({
    backend: {
      platform,
      captureSnapshot: async () => {
        const capture = captures[Math.min(index++, captures.length - 1)];
        if (capture instanceof AppError) throw capture;
        return capture!;
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default' }]),
    policy: localCommandPolicy(),
    clock: createFakeClock(),
  });
}

async function waitAbsent(device: ReturnType<typeof createAgentDevice>, timeoutMs = 1000) {
  return await device.selectors.wait({
    session: 'default',
    target: { kind: 'absent', selector: SELECTOR, timeoutMs },
  });
}

test('wait absent succeeds immediately when the selector has zero matches', async () => {
  const result = await waitAbsent(absentDevice([snapshot()]));

  assert.deepEqual(result, { kind: 'absent', waitedMs: 0 });
});

test('wait absent polls until a present selector disappears', async () => {
  let captures = 0;
  const device = absentDevice([snapshot('Removed'), snapshot()]);
  const originalCapture = device.backend.captureSnapshot;
  device.backend.captureSnapshot = async (...args) => {
    captures += 1;
    if (!originalCapture) throw new Error('the test device must expose captureSnapshot');
    return await originalCapture(...args);
  };

  const result = await waitAbsent(device, 2000);

  assert.equal(result.kind, 'absent');
  assert.equal(captures, 2);
  assert.equal(result.waitedMs >= 300, true);
});

test('wait absent reports stable first-match evidence when one match remains at the deadline', async () => {
  const device = absentDevice([snapshot('Removed')]);

  await assert.rejects(waitAbsent(device, 500), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.details?.reason, 'wait_target_present');
    assert.equal(error.details?.timeoutMs, 500);
    assert.equal(typeof error.details?.waitedMs, 'number');
    assert.equal(error.details?.matches, 1);
    assert.deepEqual(error.details?.firstMatch, {
      id: 'removed',
      role: 'button',
      label: 'Removed',
    });
    assert.equal(error.details?.readableCaptures, 2);
    return true;
  });
});

test('wait absent reports the complete match count at the deadline', async () => {
  const device = absentDevice([
    {
      snapshot: makeSnapshotState([
        { index: 0, depth: 0, type: 'Button', identifier: 'one', label: 'Removed' },
        { index: 1, depth: 0, type: 'Button', identifier: 'two', label: 'Removed' },
      ]),
    },
  ]);

  await assert.rejects(waitAbsent(device, 500), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.details?.reason, 'wait_target_present');
    assert.equal(error.details?.matches, 2);
    assert.equal((error.details?.firstMatch as { id?: string })?.id, 'one');
    assert.equal(error.details?.visibility, undefined);
    return true;
  });
});

test('wait absent rides out sparse and truncated captures without counting them as readable', async () => {
  const sparse = snapshot(undefined, {
    snapshotQuality: {
      state: 'sparse',
      backend: 'private-ax',
      reason: 'sparse tree',
      reasonCode: 'sparse-tree',
    },
  });
  const truncated = { snapshot: makeSnapshotState([]), truncated: true };
  const device = absentDevice([sparse, truncated, snapshot()]);

  const result = await waitAbsent(device, 2000);

  assert.equal(result.kind, 'absent');
  assert.equal(result.waitedMs >= 600, true);
});

test('wait absent excludes sparse and truncated polls from deadline readable-capture evidence', async () => {
  const sparse = snapshot(undefined, {
    snapshotQuality: { state: 'sparse', backend: 'private-ax', reasonCode: 'sparse-tree' },
  });
  const truncated = { snapshot: makeSnapshotState([]), truncated: true };
  const device = absentDevice([snapshot('Removed'), sparse, truncated]);

  await assert.rejects(waitAbsent(device, 500), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.details?.reason, 'wait_target_present');
    assert.equal(error.details?.readableCaptures, 1);
    assert.equal(error.details?.matches, 1);
    return true;
  });
});

test('wait absent rides out Android unreadable content and does not use it as absence', async () => {
  const device = absentDevice([unreadableCapture(), snapshot()], 'android');

  const result = await waitAbsent(device, 2000);

  assert.equal(result.kind, 'absent');
  assert.equal(result.waitedMs >= 300, true);
});

test('wait absent preserves the final typed diagnostic when no valid capture arrives', async () => {
  const sparse = snapshot(undefined, {
    snapshotQuality: { state: 'sparse', backend: 'private-ax', reasonCode: 'sparse-tree' },
  });
  const device = absentDevice([sparse]);

  await assert.rejects(waitAbsent(device, 500), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.details?.observation, 'sparse');
    assert.equal(error.details?.reason, 'predicate_failed');
    assert.equal(error.details?.readableCaptures, undefined);
    return true;
  });
});

test('wait absent preserves a final truncated diagnostic when no valid capture arrives', async () => {
  const device = absentDevice([{ snapshot: makeSnapshotState([]), truncated: true }]);

  await assert.rejects(waitAbsent(device, 500), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.details?.observation, 'truncated');
    assert.equal(error.details?.reason, 'predicate_failed');
    assert.equal(error.details?.readableCaptures, undefined);
    return true;
  });
});

test('wait absent preserves a final Android unreadable diagnostic when no valid capture arrives', async () => {
  const device = absentDevice([unreadableCapture()], 'android');

  await assert.rejects(waitAbsent(device, 500), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.details?.observation, 'unreadable');
    assert.equal(error.details?.captureErrorReason, 'empty-helper-output');
    assert.equal(error.details?.readableCaptures, undefined);
    return true;
  });
});
