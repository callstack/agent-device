import type { ApplicationLifecycleRuntimeOperations } from '@agent-device/contracts/application-lifecycle-runtime';
import {
  bindDirectApplicationLifecycle,
  bindProviderApplicationLifecycleInteractor,
} from '@agent-device/contracts/application-lifecycle-interaction';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

type DoublespeedLifecycleParams = Readonly<{
  device: DeviceInfo;
  signal: AbortSignal;
  getInteractor(device: DeviceInfo, runner?: RunnerContext): Interactor | undefined;
}>;

export const DOUBLESPEED_PORT_REVERSE_UNSUPPORTED =
  'Doublespeed iOS sessions cannot reach local host ports; use a bridge public URL.';

/** Doublespeed owns its live-session lifecycle and relaunch; it exposes no port reverse. */
export function bindDoublespeedApplicationLifecycle(
  params: DoublespeedLifecycleParams,
): ApplicationLifecycleRuntimeOperations {
  return bindDirectApplicationLifecycle({
    owner: 'Doublespeed',
    openTargetIdentity: 'bundle-id',
    closeBeforeRelaunch: true,
    configureProviderPortReverse: async () => {
      throw new AppError('UNSUPPORTED_OPERATION', DOUBLESPEED_PORT_REVERSE_UNSUPPORTED, {
        command: 'port reverse',
      });
    },
    binding: bindProviderApplicationLifecycleInteractor({
      device: params.device,
      signal: params.signal,
      resolveInteractor: (runner) => params.getInteractor(params.device, runner),
    }),
  });
}
