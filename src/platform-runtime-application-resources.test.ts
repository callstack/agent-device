import { expect, test, vi } from 'vitest';
import type {
  AndroidApplicationTools,
  AppleApplicationTools,
} from '@agent-device/contracts/application-lifecycle-runtime';
import { createApplicationResourceLifecycle } from './platform-runtime-application-resources.ts';

function lifecycle(overrides: {
  hasTestImeRecoveryEvidence: AndroidApplicationTools['hasTestImeRecoveryEvidence'];
  recoverTestImeStartup: AndroidApplicationTools['recoverTestImeStartup'];
  detachRunnerSessionsForShutdown?: AppleApplicationTools['detachRunnerSessionsForShutdown'];
  finalizeRunnerSessionsForShutdown?: AppleApplicationTools['finalizeRunnerSessionsForShutdown'];
  closeValidatorPreparation?: () => Promise<void>;
}) {
  return createApplicationResourceLifecycle({
    android: {
      hasTestImeRecoveryEvidence: overrides.hasTestImeRecoveryEvidence,
      recoverTestImeStartup: overrides.recoverTestImeStartup,
    } as unknown as AndroidApplicationTools,
    apple: {
      detachRunnerSessionsForShutdown:
        overrides.detachRunnerSessionsForShutdown ?? (async () => {}),
      finalizeRunnerSessionsForShutdown:
        overrides.finalizeRunnerSessionsForShutdown ?? (async () => {}),
    } as unknown as AppleApplicationTools,
    recording: {
      closeValidatorPreparation: overrides.closeValidatorPreparation ?? (async () => {}),
    },
  });
}

test('startup recovery reaches Android mechanics only after validated marker evidence', async () => {
  const hasTestImeRecoveryEvidence = vi.fn(async () => false);
  const recoverTestImeStartup = vi.fn(async () => {});
  const resources = lifecycle({ hasTestImeRecoveryEvidence, recoverTestImeStartup });
  const stateDir = '/tmp/platform-runtime-marker-evidence';

  await resources.recoverStartupResources({ stateDir });

  expect(hasTestImeRecoveryEvidence).toHaveBeenCalledExactlyOnceWith(stateDir);
  expect(recoverTestImeStartup).not.toHaveBeenCalled();

  hasTestImeRecoveryEvidence.mockResolvedValueOnce(true);
  await resources.recoverStartupResources({ stateDir });

  expect(recoverTestImeStartup).toHaveBeenCalledExactlyOnceWith({ stateDir });
});

test('daemon shutdown phases delegate to the Apple runner owner', async () => {
  const detachRunnerSessionsForShutdown = vi.fn(async () => ['ios-sim']);
  const finalizeRunnerSessionsForShutdown = vi.fn(async () => ['ios-sim']);
  const closeValidatorPreparation = vi.fn(async () => {});
  const resources = lifecycle({
    hasTestImeRecoveryEvidence: async () => false,
    recoverTestImeStartup: async () => {},
    detachRunnerSessionsForShutdown,
    finalizeRunnerSessionsForShutdown,
    closeValidatorPreparation,
  });

  await resources.detachForDaemonShutdown();
  await resources.finalizeDaemonShutdown();

  expect(detachRunnerSessionsForShutdown).toHaveBeenCalledOnce();
  expect(finalizeRunnerSessionsForShutdown).toHaveBeenCalledOnce();
  expect(closeValidatorPreparation).toHaveBeenCalledOnce();
});

test('a validator compile is closed before the device sweep that may wait on a recorder', async () => {
  const order: string[] = [];
  const resources = lifecycle({
    hasTestImeRecoveryEvidence: async () => false,
    recoverTestImeStartup: async () => {},
    finalizeRunnerSessionsForShutdown: async () => {
      order.push('runners');
      return [];
    },
    closeValidatorPreparation: async () => {
      order.push('validator');
    },
  });

  await resources.finalizeDaemonShutdown();

  expect(order).toEqual(['validator', 'runners']);
});

test('a failing runner sweep still closes the validator compile and reports its own failure', async () => {
  const sweepFailure = new Error('runner finalization failed');
  const closeValidatorPreparation = vi.fn(async () => {});
  const resources = lifecycle({
    hasTestImeRecoveryEvidence: async () => false,
    recoverTestImeStartup: async () => {},
    finalizeRunnerSessionsForShutdown: async () => {
      throw sweepFailure;
    },
    closeValidatorPreparation,
  });

  await expect(resources.finalizeDaemonShutdown()).rejects.toBe(sweepFailure);
  expect(closeValidatorPreparation).toHaveBeenCalledOnce();
});

test('a failed validator close is reported when the runner sweep succeeded', async () => {
  const closeFailure = new Error('swiftc cleanup failed');
  const resources = lifecycle({
    hasTestImeRecoveryEvidence: async () => false,
    recoverTestImeStartup: async () => {},
    finalizeRunnerSessionsForShutdown: async () => ['ios-sim'],
    closeValidatorPreparation: async () => {
      throw closeFailure;
    },
  });

  await expect(resources.finalizeDaemonShutdown()).rejects.toBe(closeFailure);
});

test('shutdown retains both runner and validator cleanup failures', async () => {
  const runner = new Error('runner failure');
  const validator = new Error('validator failure');
  const resources = lifecycle({
    hasTestImeRecoveryEvidence: async () => false,
    recoverTestImeStartup: async () => {},
    finalizeRunnerSessionsForShutdown: async () => {
      throw runner;
    },
    closeValidatorPreparation: async () => {
      throw validator;
    },
  });
  const failure = await resources.finalizeDaemonShutdown().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([runner, validator]);
  expect((failure as AggregateError).cause).toBe(runner);
});
