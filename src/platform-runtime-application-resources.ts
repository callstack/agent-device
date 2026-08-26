import type {
  AndroidApplicationTools,
  AppleApplicationTools,
  ApplicationLifecycleResourceLifecycle,
} from '@agent-device/contracts/application-lifecycle-runtime';

/**
 * The durable lifecycle resources this host composes. Each phase names the platforms that own
 * durable device or process state across requests, so the neutral gateway coordinates *when* a
 * phase runs while the platforms keep *what* it does. Every step stays behind its own evidence
 * check so a daemon with no such state issues no device calls at all.
 */
export function createApplicationResourceLifecycle(tools: {
  android: AndroidApplicationTools;
  apple: AppleApplicationTools;
}): ApplicationLifecycleResourceLifecycle {
  return Object.freeze({
    // Android test IME is the one durable device mutation that outlives a crashed daemon. The
    // marker read is the evidence gate: without it the Android mechanics are never imported.
    recoverStartupResources: async (input) => {
      if (!(await tools.android.hasTestImeRecoveryEvidence(input.stateDir))) return;
      await tools.android.recoverTestImeStartup(input);
    },
    detachForDaemonShutdown: async () => await tools.apple.detachRunnerSessionsForShutdown(),
    finalizeDaemonShutdown: async () => await tools.apple.finalizeRunnerSessionsForShutdown(),
  });
}
