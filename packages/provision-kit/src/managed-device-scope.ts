import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import { deviceIdentity, sameDeviceIdentity, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { createScopedProvider } from '@agent-device/kernel/scoped-provider';

type ManagedDeviceScope = NonNullable<PlatformRequestScope['managedDevice']>;
const scope = createScopedProvider<ManagedDeviceScope | undefined>(undefined);

export function currentManagedDeviceScope(): ManagedDeviceScope | undefined {
  return scope.resolve();
}

export async function withManagedDeviceScope<T>(
  managed: ManagedDeviceScope,
  task: () => Promise<T>,
): Promise<T> {
  return await scope.run(managed, task);
}

export function assertManagedDeviceIdentity(managed: ManagedDeviceScope, device: DeviceInfo): void {
  if (
    !sameDeviceIdentity(deviceIdentity(managed.device), deviceIdentity(device)) ||
    managed.device.simulatorSetPath !== device.simulatorSetPath
  ) {
    throw new AppError('COMMAND_FAILED', 'Managed automation cannot select another device.', {
      reason: 'managed-device-transport-mismatch',
    });
  }
}

export function resolveManagedDeviceReadiness():
  | ((device: DeviceInfo) => Promise<void>)
  | undefined {
  const managed = currentManagedDeviceScope();
  if (!managed) return undefined;
  return async (device) => {
    assertManagedDeviceIdentity(managed, device);
  };
}

export async function delegateManagedDeviceReadiness(device: DeviceInfo): Promise<boolean> {
  const ensureReady = resolveManagedDeviceReadiness();
  if (!ensureReady) return false;
  await ensureReady(device);
  return true;
}
