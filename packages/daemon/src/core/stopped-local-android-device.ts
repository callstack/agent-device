import type { EnsureReadyInput } from '@agent-device/contracts/device-readiness-runtime';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';
import { ensureReadyUse } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { resolveAndroidSerialAllowlist } from '@agent-device/kernel/device-isolation';
import type { EnvMap } from '@agent-device/kernel/source-value';
import type { DaemonRequest } from './daemon-request.ts';
import type { BindDeviceRuntime } from './request-runtime-binding.ts';

type DeviceReadinessFlags = Pick<
  NonNullable<DaemonRequest['flags']>,
  'serial' | 'androidDeviceAllowlist'
>;

/**
 * The readiness input of a request that boots a device. It carries the request's `--serial` and
 * Android serial allowlist, so a boot only accepts a device the request may use.
 */
export function resolveDeviceReadinessInput(params: {
  flags: DeviceReadinessFlags;
  env: EnvMap;
  deadlineAtMs: number | undefined;
}): EnsureReadyInput {
  const allowlist = resolveAndroidSerialAllowlist(params.flags.androidDeviceAllowlist, params.env);
  return {
    serial: params.flags.serial,
    androidSerialAllowlist: allowlist ? [...allowlist].sort() : undefined,
    deadlineAtMs: params.deadlineAtMs,
  };
}

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
  flags: DeviceReadinessFlags;
  env: EnvMap;
  deadlineAtMs: number | undefined;
}): Promise<DeviceInfo | undefined> {
  const { device, owner } = params;
  if (owner.kind !== 'local-family' || device.platform !== 'android' || device.booted === true) {
    return undefined;
  }
  const readiness = await params.bindDevice(device, ensureReadyUse);
  return await readiness.operations.ensureReady(resolveDeviceReadinessInput(params));
}
