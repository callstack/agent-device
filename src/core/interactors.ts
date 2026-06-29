import type { DeviceInfo } from '../utils/device.ts';
import { AppError } from '../utils/errors.ts';
import { getProviderDeviceInteractor, isActiveProviderDevice } from '../provider-device-runtime.ts';
import type { Interactor, RunnerContext } from './interactor-types.ts';

export async function getInteractor(
  device: DeviceInfo,
  runnerContext: RunnerContext,
): Promise<Interactor> {
  if (isActiveProviderDevice(device)) {
    const providerInteractor = getProviderDeviceInteractor(device);
    if (providerInteractor) return providerInteractor;
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'Provider device runtime does not have an active interactor for this device.',
      { deviceId: device.id, platform: device.platform },
    );
  }

  switch (device.platform) {
    case 'android': {
      const { createAndroidInteractor } = await import('./interactors/android.ts');
      return createAndroidInteractor(device);
    }
    case 'linux': {
      const { createLinuxInteractor } = await import('./interactors/linux.ts');
      return createLinuxInteractor();
    }
    case 'web': {
      const { createWebInteractor } = await import('./interactors/web.ts');
      return createWebInteractor();
    }
    case 'ios':
    case 'macos': {
      const { createAppleInteractor } = await import('./interactors/apple.ts');
      return createAppleInteractor(device, runnerContext);
    }
    default:
      throw new AppError('UNSUPPORTED_PLATFORM', `Unsupported platform: ${device.platform}`);
  }
}
