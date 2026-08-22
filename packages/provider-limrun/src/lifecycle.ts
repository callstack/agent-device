import type { ApplicationLifecycleRuntimeOperations } from '@agent-device/contracts/platform';
import {
  bindDirectApplicationLifecycle,
  bindProviderApplicationLifecycleInteractor,
} from '@agent-device/contracts/application-lifecycle-interaction';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interaction';
import type { ProviderPortReverseOptions } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';

type LimrunLifecycleParams = Readonly<{
  device: DeviceInfo;
  signal: AbortSignal;
  getInteractor(device: DeviceInfo, runner?: RunnerContext): Interactor | undefined;
  configurePortReverse(
    options: ProviderPortReverseOptions,
  ): Promise<Record<string, unknown> | undefined>;
}>;

/** Limrun owns its live-session lifecycle, relaunch, and exact port-reverse mechanics. */
export function bindLimrunApplicationLifecycle(
  params: LimrunLifecycleParams,
): ApplicationLifecycleRuntimeOperations {
  return bindDirectApplicationLifecycle({
    owner: 'Limrun',
    openTargetIdentity: 'bundle-id',
    closeBeforeRelaunch: true,
    configureProviderPortReverse: async (input) => await params.configurePortReverse(input),
    binding: bindProviderApplicationLifecycleInteractor({
      device: params.device,
      signal: params.signal,
      resolveInteractor: (runner) => params.getInteractor(params.device, runner),
    }),
  });
}
