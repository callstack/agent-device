import type {
  ApplicationLifecycleRuntimeOperations,
  LocalApplicationInteractorHost,
} from '@agent-device/contracts/application-lifecycle-runtime';
import {
  bindDirectApplicationLifecycle,
  bindLocalApplicationLifecycleInteractor,
} from '@agent-device/contracts/application-lifecycle-interaction';
import type { DeviceInfo } from '@agent-device/kernel/device';

type HarmonyLifecycleParams = Readonly<{
  host: LocalApplicationInteractorHost;
  device: DeviceInfo;
  signal: AbortSignal;
}>;

/** HarmonyOS owns bundle selection and direct lifecycle dispatch after local binding. */
export function bindHarmonyApplicationLifecycle(
  params: HarmonyLifecycleParams,
): ApplicationLifecycleRuntimeOperations {
  return bindDirectApplicationLifecycle({
    owner: 'HarmonyOS',
    openTargetIdentity: 'bundle-id',
    binding: bindLocalApplicationLifecycleInteractor({
      device: params.device,
      signal: params.signal,
      resolveInteractor: params.host.resolve,
    }),
  });
}
