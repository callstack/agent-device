import type {
  ApplicationLifecycleRuntimeOperations,
  LocalApplicationInteractorHost,
} from '@agent-device/contracts/platform';
import {
  bindDirectApplicationLifecycle,
  bindLocalApplicationLifecycleInteractor,
} from '@agent-device/contracts/application-lifecycle-interaction';
import type { DeviceInfo } from '@agent-device/kernel/device';

type WebLifecycleParams = Readonly<{
  host: LocalApplicationInteractorHost;
  device: DeviceInfo;
  signal: AbortSignal;
}>;

/** Web owns browser lifecycle dispatch after its local owner is bound. */
export function bindWebApplicationLifecycle(
  params: WebLifecycleParams,
): ApplicationLifecycleRuntimeOperations {
  return bindDirectApplicationLifecycle({
    owner: 'web',
    openTargetIdentity: 'app-name',
    binding: bindLocalApplicationLifecycleInteractor({
      device: params.device,
      signal: params.signal,
      resolveInteractor: params.host.resolve,
    }),
  });
}
