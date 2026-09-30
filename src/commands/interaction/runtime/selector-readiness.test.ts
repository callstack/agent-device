import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { selector } from './selector-read-utils.ts';
import { createFakeClock, createInteractionDevice } from './__tests__/test-utils/index.ts';

// promotedTarget's readiness poll runs only when the caller supplies `readinessTimeoutMs`, capped
// at the row's `maxTimeoutMs` (2_000). These pin the gating/capping decision at the runtime layer; the end-to-end poll mechanics (interactive/fresh
// capture sequencing, covered-target diagnosis, ridden-out capture errors) are unit-tested at the
// daemon level in test/integration/provider-scenarios/press-target-readiness.test.ts.

const CONTINUE_BUTTON = {
  index: 0,
  depth: 0,
  type: 'Button',
  label: 'Continue',
  rect: { x: 10, y: 20, width: 100, height: 40 },
  hittable: true,
};

test('runtime press without readinessTimeoutMs takes the one-attempt path and reports no readiness evidence', async () => {
  let captures = 0;
  const device = createInteractionDevice(makeSnapshotState([]), {
    captureSnapshot: async () => {
      captures += 1;
      return { snapshot: makeSnapshotState([]) };
    },
  });

  await assert.rejects(
    () => device.interactions.press(selector('label=Continue'), { session: 'default' }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.readiness, undefined);
      return true;
    },
  );
  // The interactive-capture-then-full-capture-fallback pair, not the readiness loop's repeated
  // polling.
  assert.equal(captures, 2);
});

test('runtime press with readinessTimeoutMs polls until the target appears', async () => {
  let captures = 0;
  const device = createInteractionDevice(makeSnapshotState([]), {
    clock: createFakeClock(),
    captureSnapshot: async () => {
      captures += 1;
      // Every capture before the fourth misses; the fourth (and every one after) has the button.
      return { snapshot: makeSnapshotState(captures >= 4 ? [CONTINUE_BUTTON] : []) };
    },
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
    readinessTimeoutMs: 2_000,
  });

  assert.equal(result.kind, 'selector');
  assert.equal(result.node?.label, 'Continue');
  assert.ok(
    captures >= 4,
    `expected at least 4 captures before the target appeared, got ${captures}`,
  );
});

test('runtime press caps a readinessTimeoutMs larger than the row maxTimeoutMs at 2_000ms', async () => {
  const device = createInteractionDevice(makeSnapshotState([]), {
    clock: createFakeClock(),
    captureSnapshot: async () => ({ snapshot: makeSnapshotState([]) }),
  });

  await assert.rejects(
    () =>
      device.interactions.press(selector('label=Continue'), {
        session: 'default',
        // Far past the promotedTarget row's own maxTimeoutMs (2_000): the row's cap governs, not
        // this caller-supplied value.
        readinessTimeoutMs: 999_000,
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      const readiness = error.details?.readiness as { waitedMs: number; end: string } | undefined;
      assert.ok(readiness, 'expected readiness evidence on an exhausted poll');
      assert.equal(readiness.end, 'expired');
      assert.ok(
        readiness.waitedMs >= 2_000 && readiness.waitedMs <= 2_200,
        `expected waitedMs capped near 2_000ms, got ${readiness.waitedMs}`,
      );
      return true;
    },
  );
});

test('runtime press whose every capture is unreadable fails with the unreadable-content error, not a selector miss', async () => {
  let captures = 0;
  const device = createInteractionDevice(makeSnapshotState([]), {
    clock: createFakeClock(),
    captureSnapshot: async () => {
      captures += 1;
      throw new AppError('COMMAND_FAILED', 'Android snapshot has no readable app content', {
        androidSnapshotHelperFailureReason: 'system-window-only',
      });
    },
  });

  await assert.rejects(
    () =>
      device.interactions.press(selector('label=Continue'), {
        session: 'default',
        readinessTimeoutMs: 2_000,
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.androidSnapshotHelperFailureReason, 'system-window-only');
      assert.notEqual(error.details?.reason, 'selector_not_found');
      return true;
    },
  );
  assert.ok(captures >= 2, `expected the unreadable captures to be ridden out, got ${captures}`);
});
