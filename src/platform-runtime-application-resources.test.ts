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
  const detachRunnerSessionsForShutdown = vi.fn(async () => {});
  const finalizeRunnerSessionsForShutdown = vi.fn(async () => {});
  const resources = lifecycle({
    hasTestImeRecoveryEvidence: async () => false,
    recoverTestImeStartup: async () => {},
    detachRunnerSessionsForShutdown,
    finalizeRunnerSessionsForShutdown,
  });

  await resources.detachForDaemonShutdown();
  await resources.finalizeDaemonShutdown();

  expect(detachRunnerSessionsForShutdown).toHaveBeenCalledOnce();
  expect(finalizeRunnerSessionsForShutdown).toHaveBeenCalledOnce();
});
