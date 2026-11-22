import { expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { limrunRunnerError, withLimrunRunnerErrors } from './ios-runner-errors.ts';

test.each(['capture-failed', 'budget'] as const)(
  'reports %s snapshot failure with a remote recovery hint',
  async (reasonCode) => {
    const error = new AppError('COMMAND_FAILED', 'invalid viewport', {
      reason: 'invalid-viewport',
      snapshotQuality: { state: 'sparse', reasonCode },
    });
    await expect(
      withLimrunRunnerErrors(async () => {
        throw error;
      }),
    ).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: {
        reason: 'limrun_runner_snapshot_unavailable',
        hint: expect.stringContaining('recreate the Limrun instance'),
        snapshotQuality: { reasonCode },
      },
      cause: error,
    });
  },
);

test('does not classify matching text without capture-failure evidence', async () => {
  const error = new AppError(
    'COMMAND_FAILED',
    'the XCTest tree capture exceeded its 8s time slice',
    { reason: 'invalid-viewport' },
  );
  await expect(
    withLimrunRunnerErrors(async () => {
      throw error;
    }),
  ).rejects.toBe(error);
});

test('shared startup failures retain their reason with a remote toolchain recovery hint', async () => {
  const error = new AppError('COMMAND_FAILED', 'Runner did not accept connection', {
    reason: 'IOS_RUNNER_CONNECT_TIMEOUT',
    runnerConnectFailureReason: 'runner_connect_refused',
  });
  await expect(
    withLimrunRunnerErrors(async () => {
      throw error;
    }),
  ).rejects.toMatchObject({
    details: {
      reason: 'IOS_RUNNER_CONNECT_TIMEOUT',
      hint: expect.stringContaining('instance’s Xcode'),
    },
    cause: error,
  });
});

test('a runner failure that echoes the forwarded credential publishes it scrubbed', async () => {
  const token = 'abc123';
  const error = new AppError('COMMAND_FAILED', `the command route refused ${token}`, {
    reason: 'IOS_RUNNER_CONNECT_TIMEOUT',
    response: `401 Unauthorized: ${token}`,
  });

  let failure: unknown;
  await withLimrunRunnerErrors(async () => {
    throw error;
  }, [`Bearer ${token}`]).catch((error: unknown) => {
    failure = error;
  });

  const published = failure as AppError;
  expect(published.code).toBe('COMMAND_FAILED');
  expect(published.details?.reason).toBe('IOS_RUNNER_CONNECT_TIMEOUT');
  expect(JSON.stringify({ message: published.message, details: published.details })).not.toContain(
    token,
  );
});

test('retains product-specific recovery instructions over the default hint', () => {
  expect(
    limrunRunnerError('productsInvalid', 'Invalid runner', {
      hint: 'Use the simulator product from this build.',
    }).details?.hint,
  ).toBe('Use the simulator product from this build.');
  expect(limrunRunnerError('productsInvalid', 'Invalid runner').details?.hint).toContain(
    'AGENT_DEVICE_LIMRUN_IOS_RUNNER_APP',
  );
});

test('publishes each runner failure from its row, never from a caller spelling', () => {
  expect(limrunRunnerError('productsInvalid', 'Invalid runner').details?.reason).toBe(
    'limrun_runner_products_invalid',
  );
  // @ts-expect-error A call site names a LIMRUN_RUNNER_REASONS row, not its published spelling.
  expect(() => limrunRunnerError('limrun_runner_products_invalid', 'Invalid runner')).toThrow(
    TypeError,
  );
});
