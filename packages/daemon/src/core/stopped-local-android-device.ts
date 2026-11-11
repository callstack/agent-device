import type { EnsureReadyInput } from '@agent-device/contracts/device-readiness-runtime';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';
import { ensureReadyUse } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { BindDeviceRuntime } from './request-runtime-binding.ts';

/**
 * Boots a local Android device that is not booted, such as a stopped AVD that inventory lists by
 * its AVD name, and returns the booted device with its adb serial. A command that addresses such
 * a device continues with the returned identity, so every later binding, claim and lock keys on
 * the serial. Returns undefined when the device needs no boot here.
 */
export async function bootStoppedLocalAndroidDevice(params: {
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  bindDevice: BindDeviceRuntime;
  input: EnsureReadyInput;
}): Promise<DeviceInfo | undefined> {
  const { device, owner } = params;
  if (owner.kind !== 'local-family' || device.platform !== 'android' || device.booted === true) {
    return undefined;
  }
  const readiness = await params.bindDevice(device, ensureReadyUse);
  return await readiness.operations.ensureReady(params.input);
}
