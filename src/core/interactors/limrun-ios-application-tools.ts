import type { AppleApplicationTools } from '@agent-device/contracts/application-lifecycle-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';

type RunnerLifecycle = {
  prepareCache(signal?: AbortSignal): Promise<void>;
  prewarm(
    execution: Parameters<AppleApplicationTools['prewarmRunnerSession']>[1],
    signal: AbortSignal,
    options?: Parameters<AppleApplicationTools['prewarmRunnerSession']>[4],
  ): Promise<void>;
  release(retain: boolean): Promise<void>;
  prepare: AppleApplicationTools['prepareRunner'];
  resetTarget(signal?: AbortSignal): Promise<void>;
  isReady(): boolean;
  isStarted(): boolean;
  stop(): Promise<void>;
  releaseSpeculative(): Promise<boolean>;
};

/** Adapts the lease-owned XCTest run to Apple's shared lifecycle ordering. */
export function createLimrunAppleApplicationTools(
  device: DeviceInfo,
  runner: RunnerLifecycle,
  hostTools: Pick<
    AppleApplicationTools,
    'resolveOpenTarget' | 'applyRuntimeHints' | 'clearRuntimeHints'
  >,
): AppleApplicationTools {
  const requireDevice = (target: DeviceInfo | string) => {
    if ((typeof target === 'string' ? target : target.id) !== device.id)
      throw new AppError(
        'DEVICE_NOT_FOUND',
        'Apple lifecycle tools belong to a different Limrun lease',
      );
  };
  return {
    resolveOpenTarget: async (target, input) => {
      requireDevice(target);
      return await hostTools.resolveOpenTarget(target, input);
    },
    prewarmRunnerCache: async (target, _execution, signal) => {
      requireDevice(target);
      await runner.prepareCache(signal);
    },
    prewarmRunnerSession: async (target, execution, signal, propagateError, options) => {
      requireDevice(target);
      try {
        await runner.prewarm(execution, signal, options);
      } catch (error) {
        if (propagateError) throw error;
        emitDiagnostic({
          level: 'warn',
          phase: 'limrun.runner.prewarm_failed',
          data: { error: String(error) },
        });
      }
    },
    notifyRunnerAppRelaunched: async (target, _execution, signal) => {
      requireDevice(target);
      await runner.resetTarget(signal);
    },
    stopRunnerSession: async (id) => {
      requireDevice(id);
      await runner.stop();
    },
    hasLiveRunnerSession: async (target) => {
      requireDevice(target);
      return runner.isReady();
    },
    releaseSpeculativeRunner: async (target) => {
      requireDevice(target);
      return await runner.releaseSpeculative();
    },
    releaseRunnerOnClose: async (id, options) => {
      requireDevice(id);
      await runner.release(options.retain);
    },
    prepareRunner: async (target, input, signal) => {
      requireDevice(target);
      return await runner.prepare(target, input, signal);
    },
    applyRuntimeHints: async (target, input) => {
      requireDevice(target);
      await hostTools.applyRuntimeHints(target, input);
    },
    clearRuntimeHints: async (target, input) => {
      requireDevice(target);
      await hostTools.clearRuntimeHints(target, input);
    },
    // Local Apple close-alert cleanup applies only to macOS, never iOS simulators.
    dismissCloseAlerts: async (target) => {
      requireDevice(target);
    },
    detachRunnerSessionsForShutdown: async () => {
      // The managed XCTest stream cannot be adopted by another daemon.
      await runner.stop();
      return [];
    },
    finalizeRunnerSessionsForShutdown: async () => {
      const started = runner.isStarted();
      await runner.stop();
      return started ? [device.id] : [];
    },
  };
}
