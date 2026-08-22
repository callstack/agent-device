import type {
  ApplicationLifecycleRuntimeOperations,
  LocalApplicationInteractorHost,
} from '@agent-device/contracts/platform';
import {
  bindDirectApplicationLifecycle,
  bindLocalApplicationLifecycleInteractor,
} from '@agent-device/contracts/application-lifecycle-interaction';
import type { DeviceInfo } from '@agent-device/kernel/device';

type VegaLifecycleParams = Readonly<{
  host: LocalApplicationInteractorHost;
  device: DeviceInfo;
  signal: AbortSignal;
}>;

/** Vega owns its virtual-device lifecycle behavior after the local owner is bound. */
export function bindVegaApplicationLifecycle(
  params: VegaLifecycleParams,
): ApplicationLifecycleRuntimeOperations {
  return bindDirectApplicationLifecycle({
    owner: 'Vega',
    openTargetIdentity: 'app-name',
    binding: bindLocalApplicationLifecycleInteractor({
      device: params.device,
      signal: params.signal,
      resolveInteractor: params.host.resolve,
    }),
  });
}
