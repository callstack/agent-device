import { publicPlatformString, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { getProviderDeviceInteractor, isActiveProviderDevice } from '../provider-device-runtime.ts';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import { builtinPlatformPlugins } from './interactors/builtin-platform-plugin-set.ts';
import type { PlatformPluginSet } from '@agent-device/contracts/platform-plugin';

export async function getInteractor(
  device: DeviceInfo,
  runnerContext: RunnerContext,
  host: HostEnvironment,
  plugins: PlatformPluginSet = builtinPlatformPlugins,
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

  return await getLocalInteractor(device, runnerContext, host, plugins);
}

/**
 * Resolves a local platform interactor after its runtime owner has already been selected.
 * Lifecycle bindings use this exact-owner path so an ambient provider request scope cannot
 * redirect a local binding to a provider interactor. `host` is the calling runtime's host;
 * plugins are shared across runtimes, so it arrives per call.
 */
export async function getLocalInteractor(
  device: DeviceInfo,
  runnerContext: RunnerContext,
  host: HostEnvironment,
  plugins: PlatformPluginSet = builtinPlatformPlugins,
): Promise<Interactor> {
  return await plugins.get(device.platform).plugin.createInteractor(device, runnerContext, host);
}
