import type {
  LeaseEnvironmentError,
  ManagedLease,
  ManagedLeaseEnvironment,
  ManagedLeaseEnvironmentKey,
  ManagedLeasePlatform,
} from '@agent-device/contracts/managed-device-allocation';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

export type ManagedLeaseReachabilityInput = Readonly<{
  platform: ManagedLeasePlatform;
  lease: ManagedLease;
}>;

export type ManagedLeaseReachability = Readonly<{
  platform: ManagedLeasePlatform;
  lease: ManagedLease;
  environment: ManagedLeaseEnvironment;
  device: DeviceInfo;
  run<T>(task: () => Promise<T>): Promise<T>;
}>;

export function readManagedLeaseEnvironment(
  platform: ManagedLeasePlatform,
  environment: Readonly<Record<string, string | undefined>>,
): ManagedLeaseEnvironment | LeaseEnvironmentError {
  if (platform === 'ios') {
    const deviceSetPath = environment.SIMLOCK_IOS_DEVICE_SET?.trim();
    return deviceSetPath
      ? Object.freeze({ platform, deviceSetPath })
      : invalidEnvironment(platform, 'SIMLOCK_IOS_DEVICE_SET');
  }

  const rawPort = environment.ANDROID_ADB_SERVER_PORT?.trim();
  const adbServerPort = rawPort && /^\d+$/.test(rawPort) ? Number(rawPort) : Number.NaN;
  return Number.isInteger(adbServerPort) && adbServerPort >= 1 && adbServerPort <= 65_535
    ? Object.freeze({ platform, adbServerPort })
    : invalidEnvironment(platform, 'ANDROID_ADB_SERVER_PORT');
}

export function createManagedLeaseReachability(
  input: ManagedLeaseReachabilityInput,
): ManagedLeaseReachability {
  const environment = readManagedLeaseEnvironment(input.platform, input.lease.environment);
  if (isLeaseEnvironmentError(environment)) throw invalidEnvironmentError(environment);

  const address = input.lease.device.address;
  if (!address.trim()) {
    throw new AppError('COMMAND_FAILED', `Managed ${input.platform} lease has no device address.`, {
      reason: 'managed_lease_device_invalid',
      platform: input.platform,
      retriable: false,
    });
  }

  if (input.platform === 'ios') {
    if (environment.platform !== 'ios') throw new TypeError('Managed lease environment mismatch');
    const device = createManagedDevice(input.platform, address, environment);
    return Object.freeze({
      platform: input.platform,
      lease: input.lease,
      environment,
      device,
      run: async <T>(task: () => Promise<T>) => await task(),
    });
  }

  if (environment.platform !== 'android') throw new TypeError('Managed lease environment mismatch');
  const device = createManagedDevice(input.platform, address, environment);
  let androidProvider:
    | Promise<import('@agent-device/platform-android/mechanics').AndroidAdbProvider>
    | undefined;
  const run = async <T>(task: () => Promise<T>) => {
    androidProvider ??= import('@agent-device/platform-android/mechanics').then(
      ({ createLocalAndroidAdbProvider }) =>
        createLocalAndroidAdbProvider(device, { serverPort: environment.adbServerPort }),
    );
    const { withAndroidAdbProvider } = await import('@agent-device/platform-android/mechanics');
    return await withAndroidAdbProvider(
      await androidProvider,
      { serial: device.id, serverPort: environment.adbServerPort },
      task,
    );
  };

  return Object.freeze({
    platform: input.platform,
    lease: input.lease,
    environment,
    device,
    run,
  });
}

function createManagedDevice(
  platform: ManagedLeasePlatform,
  address: string,
  environment: ManagedLeaseEnvironment,
): DeviceInfo {
  if (platform === 'ios') {
    if (environment.platform !== 'ios') throw new TypeError('Managed lease environment mismatch');
    return Object.freeze({
      platform: 'apple',
      appleOs: 'ios',
      id: address,
      name: address,
      kind: 'simulator',
      target: 'mobile',
      simulatorSetPath: environment.deviceSetPath,
    });
  }
  if (environment.platform !== 'android') throw new TypeError('Managed lease environment mismatch');
  return Object.freeze({
    platform: 'android',
    id: address,
    name: address,
    kind: 'emulator',
    target: 'mobile',
  });
}

function invalidEnvironment(
  platform: ManagedLeasePlatform,
  key: ManagedLeaseEnvironmentKey,
): LeaseEnvironmentError {
  return Object.freeze({ code: 'LEASE_ENVIRONMENT_INVALID', platform, key });
}

function isLeaseEnvironmentError(
  value: ManagedLeaseEnvironment | LeaseEnvironmentError,
): value is LeaseEnvironmentError {
  return 'code' in value;
}

function invalidEnvironmentError(error: LeaseEnvironmentError): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `Managed ${error.platform} lease environment is missing or invalid.`,
    {
      reason: 'managed_lease_environment_invalid',
      platform: error.platform,
      key: error.key,
      retriable: false,
    },
  );
}
