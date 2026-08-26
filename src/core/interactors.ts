import { publicPlatformString, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { getProviderDeviceInteractor, isActiveProviderDevice } from '../provider-device-runtime.ts';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import { getPlugin } from './platform-plugin-registry.ts';
import { registerBuiltinPlatformPlugins } from './interactors/register-builtins.ts';

// Populate the platform-plugin registry once, at module load (only registers
// lazy closures — no leaf code is imported here, so CLI cold-start is unaffected).
registerBuiltinPlatformPlugins();

export async function getInteractor(
  device: DeviceInfo,
  runnerContext: RunnerContext,
): Promise<Interactor> {
  if (isActiveProviderDevice(device)) {
    const providerInteractor = getProviderDeviceInteractor(device, runnerContext);
    if (providerInteractor) return providerInteractor;
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'Provider device runtime does not have an active interactor for this device.',
      { deviceId: device.id, platform: publicPlatformString(device) },
    );
  }

  return await getLocalInteractor(device, runnerContext);
}

/**
 * Resolves a local platform interactor after its runtime owner has already been selected.
 * Lifecycle bindings use this exact-owner path so an ambient provider request scope cannot
 * redirect a local binding to a provider interactor.
 */
export async function getLocalInteractor(
  device: DeviceInfo,
  runnerContext: RunnerContext,
): Promise<Interactor> {
  // Byte-identical replacement for the former per-platform switch: each plugin's
  // `createInteractor` is the SAME lazy dynamic import + factory call the switch
  // arm performed, and `getPlugin` throws the SAME `UNSUPPORTED_PLATFORM` AppError
  // the switch default threw. Registry exhaustiveness (BuiltinPluginsCoverAllPlatforms)
  // guarantees every leaf `Platform` resolves.
  return await getPlugin(device.platform).createInteractor(device, runnerContext);
}
