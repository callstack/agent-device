import {
  bindDirectApplicationLifecycle,
  bindProviderApplicationLifecycleInteractor,
} from '@agent-device/contracts/application-lifecycle-interaction';
import type { ApplicationLifecycleRuntimeOperations } from '@agent-device/contracts/application-lifecycle-runtime';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';

/**
 * The application lifecycle of one Revyl session.
 *
 * Revyl launches and kills through two actions that both address the session's own app, so the
 * shared direct binding is the whole implementation: the target identity is the bundle id the caller
 * named, and nothing else has to be owned — no runner, no hints, no port reverse.
 */
export function bindRevylApplicationLifecycle(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    getInteractor(device: DeviceInfo, runner?: RunnerContext): Interactor | undefined;
  }>,
): ApplicationLifecycleRuntimeOperations {
  return bindDirectApplicationLifecycle({
    owner: 'Revyl',
    openTargetIdentity: 'bundle-id',
    closeBeforeRelaunch: true,
    binding: bindProviderApplicationLifecycleInteractor({
      device: params.device,
      signal: params.signal,
      resolveInteractor: (runner) => params.getInteractor(params.device, runner),
    }),
  });
}
