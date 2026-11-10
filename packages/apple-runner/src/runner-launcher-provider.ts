import type { DeviceInfo } from '@agent-device/kernel/device';
import type { RunnerLauncher } from './runner-launcher.ts';
import type {
  AppleRunnerCommandOptions,
  AppleRunnerLifecycleOptions,
  AppleRunnerPrepareOptions,
} from './runner-provider.ts';
import type { RunnerCommand } from './runner-contract.ts';
import { executeRunnerCommand, prepareLocalIosRunner } from './runner-lifecycle.ts';
import {
  ensureRunnerSession,
  readRunnerSessionLiveness,
  releaseRunnerOnClose,
  releaseSpeculativeIosRunnerSession,
  stopRunnerSession,
} from './runner-session.ts';

/** Uses the same session registry, admissions and close policy as the local launcher. */
export function createLaunchedAppleRunnerProvider(
  device: DeviceInfo,
  launcher: RunnerLauncher,
  env: NodeJS.ProcessEnv,
) {
  return {
    runCommand: (target: DeviceInfo, command: RunnerCommand, options: AppleRunnerCommandOptions) =>
      executeRunnerCommand(target, command, { ...options, launcher }),
    prepare: (target: DeviceInfo, options: AppleRunnerPrepareOptions) =>
      prepareLocalIosRunner(target, { ...options, launcher }),
    hasLiveSession: () => readRunnerSessionLiveness(device.id)?.liveness === 'ready',
    ensure: (options: AppleRunnerLifecycleOptions) =>
      ensureRunnerSession(device, { ...options, launcher }),
    stop: () => stopRunnerSession(device.id),
    release: (retain: boolean) => releaseRunnerOnClose(device.id, { retain }, env),
    isStarted: () => readRunnerSessionLiveness(device.id) !== null,
    releaseSpeculative: () => releaseSpeculativeIosRunnerSession(device.id),
  };
}
