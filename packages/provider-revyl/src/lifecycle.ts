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
 * shared direct binding carries open and close. A relaunch is the one Revyl-specific step: `/kill_app`
 * takes no bundle id and ends whatever app the session runs, so the relaunch ends it directly rather
 * than through `close <app>`, which refuses an app this session never launched.
 */
export function bindRevylApplicationLifecycle(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    getInteractor(device: DeviceInfo, runner?: RunnerContext): Interactor | undefined;
  }>,
): ApplicationLifecycleRuntimeOperations {
  const binding = bindProviderApplicationLifecycleInteractor({
    device: params.device,
    signal: params.signal,
    resolveInteractor: (runner) => params.getInteractor(params.device, runner),
  });
  const lifecycle = bindDirectApplicationLifecycle({
    owner: 'Revyl',
    openTargetIdentity: 'bundle-id',
    closeBeforeRelaunch: false,
    binding,
  });
  return Object.freeze({
    ...lifecycle,
    openApplication: async (input) => {
      if (input.relaunch && input.target !== undefined) {
        const interactor = await binding.resolveInteractor(input.execution, input.appBundleId);
        await interactor.close('');
      }
      return await lifecycle.openApplication(input);
    },
  });
}
