import type { DeviceInfo } from '@agent-device/kernel/device';
import type {
  DeviceShutdownCloseCapability,
  DeviceShutdownRuntimeDependencies,
  DeviceShutdownRuntimeHost,
  DeviceShutdownRuntimeLoaders,
} from '@agent-device/contracts/device-shutdown-runtime';

/**
 * Neutral composition seam shared by canonical shutdown and legacy close.
 * Family mechanics stay in the owning private platform packages and load only when called.
 */
export function createDeviceShutdownRuntimeHost(
  dependencies: DeviceShutdownRuntimeDependencies,
  loaders: DeviceShutdownRuntimeLoaders,
): DeviceShutdownRuntimeHost {
  let appleRuntime: ReturnType<DeviceShutdownRuntimeLoaders['apple']> | undefined;
  let androidRuntime: ReturnType<DeviceShutdownRuntimeLoaders['android']> | undefined;

  const loadApple = async () => {
    appleRuntime ??= loaders.apple({ appleTools: dependencies.appleTools });
    return await appleRuntime;
  };
  const loadAndroid = async () => {
    androidRuntime ??= loaders.android({ commands: dependencies.commands });
    return await androidRuntime;
  };

  const apple = Object.freeze({
    shutdownTarget: async (device: DeviceInfo, signal: AbortSignal) =>
      await (await loadApple()).shutdownTarget(device, signal),
  });
  const android = Object.freeze({
    shutdownTarget: async (device: DeviceInfo, signal: AbortSignal) =>
      await (await loadAndroid()).shutdownTarget(device, signal),
  });
  const close: DeviceShutdownCloseCapability = Object.freeze({
    canShutdownTarget: async (device) => await canShutdownTarget(device, loadApple, loadAndroid),
    shutdownTarget: async (device) => await shutdownTargetForClose(device, loadApple, loadAndroid),
  });

  return Object.freeze({ apple, android, close });
}

async function canShutdownTarget(
  device: DeviceInfo,
  loadApple: () => ReturnType<DeviceShutdownRuntimeLoaders['apple']>,
  loadAndroid: () => ReturnType<DeviceShutdownRuntimeLoaders['android']>,
): Promise<boolean> {
  if (device.platform === 'apple') return (await loadApple()).canShutdownTarget(device);
  if (device.platform === 'android') return (await loadAndroid()).canShutdownTarget(device);
  return false;
}

async function shutdownTargetForClose(
  device: DeviceInfo,
  loadApple: () => ReturnType<DeviceShutdownRuntimeLoaders['apple']>,
  loadAndroid: () => ReturnType<DeviceShutdownRuntimeLoaders['android']>,
) {
  const signal = new AbortController().signal;
  if (device.platform === 'apple') return await (await loadApple()).shutdownTarget(device, signal);
  if (device.platform === 'android') {
    return await (await loadAndroid()).shutdownTarget(device, signal);
  }
  return {
    success: false,
    exitCode: -1,
    stdout: '',
    stderr: `Cannot shut down unsupported device ${device.platform}/${device.kind}`,
  } as const;
}
