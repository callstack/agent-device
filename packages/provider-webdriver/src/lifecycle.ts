import type { ApplicationLifecycleRuntimeOperations } from '@agent-device/contracts/platform';
import {
  bindDirectApplicationLifecycle,
  bindProviderApplicationLifecycleInteractor,
} from '@agent-device/contracts/application-lifecycle-interaction';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interaction';
import type { DeviceInfo } from '@agent-device/kernel/device';

type WebDriverLifecycleParams = Readonly<{
  device: DeviceInfo;
  signal: AbortSignal;
  getInteractor(device: DeviceInfo, runner?: RunnerContext): Interactor | undefined;
}>;

/** WebDriver owns its selected-session lifecycle, including provider-side relaunch close. */
export function bindWebDriverApplicationLifecycle(
  params: WebDriverLifecycleParams,
): ApplicationLifecycleRuntimeOperations {
  return bindDirectApplicationLifecycle({
    owner: 'WebDriver',
    openTargetIdentity: 'bundle-id',
    closeBeforeRelaunch: true,
    binding: bindProviderApplicationLifecycleInteractor({
      device: params.device,
      signal: params.signal,
      resolveInteractor: (runner) => params.getInteractor(params.device, runner),
    }),
  });
}
