import { publicPlatformString, type DeviceInfo } from '../kernel/device.ts';
import { AppError } from '../kernel/errors.ts';
import { getProviderDeviceInteractor, isActiveProviderDevice } from '../provider-device-runtime.ts';
import type { RunnerContext } from './interactor-types.ts';
import { getPlugin } from './platform-plugin/plugin.ts';
import { registerBuiltinPlatformPlugins } from './interactors/register-builtins.ts';
import { withGesturePerformer, type GestureInteractor } from './gesture-interactor.ts';

// Populate the platform-plugin registry once, at module load (only registers
// lazy closures — no leaf code is imported here, so CLI cold-start is unaffected).
registerBuiltinPlatformPlugins();

export async function getInteractor(
  device: DeviceInfo,
  runnerContext: RunnerContext,
): Promise<GestureInteractor> {
  if (isActiveProviderDevice(device)) {
    const providerInteractor = getProviderDeviceInteractor(device);
    if (providerInteractor) return withGesturePerformer(providerInteractor);
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'Provider device runtime does not have an active interactor for this device.',
      { deviceId: device.id, platform: publicPlatformString(device) },
    );
  }

  // Byte-identical replacement for the former per-platform switch: each plugin's
  // `createInteractor` is the SAME lazy dynamic import + factory call the switch
  // arm performed, and `getPlugin` throws the SAME `UNSUPPORTED_PLATFORM` AppError
  // the switch default threw. Registry exhaustiveness (BuiltinPluginsCoverAllPlatforms)
  // guarantees every leaf `Platform` resolves.
  return withGesturePerformer(
    await getPlugin(device.platform).createInteractor(device, runnerContext),
  );
}

export type { GestureInteractor };
