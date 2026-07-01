import type { DeviceInfo } from '../../kernel/device.ts';
import { AppError } from '../../kernel/errors.ts';
import { ensureDeviceReady } from '../device-ready.ts';
import { resolveTargetDevice } from '../../core/dispatch.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { hasExplicitDeviceSelector } from '../device-selector-intent.ts';
import { listSessionSelectorConflicts } from '../session-selector.ts';
import { isIosSimulator } from '../device-targets.ts';
import { errorResponse } from './response.ts';

export { isIosSimulator };

export const IOS_SIMULATOR_POST_CLOSE_SETTLE_MS = 300;

export const IOS_SIMULATOR_POST_OPEN_SETTLE_MS = 300;

export function requireSessionOrExplicitSelector(
  command: string,
  session: SessionState | undefined,
  flags: DaemonRequest['flags'] | undefined,
): DaemonResponse | null {
  if (session || hasExplicitDeviceSelector(flags)) {
    return null;
  }
  return errorResponse(
    'INVALID_ARGS',
    `${command} requires an active session or an explicit device selector (e.g. --platform ios).`,
  );
}

export function hasExplicitSessionFlag(flags: DaemonRequest['flags'] | undefined): boolean {
  return typeof flags?.session === 'string' && flags.session.trim().length > 0;
}

export async function settleIosSimulator(device: DeviceInfo, delayMs: number): Promise<void> {
  if (!isIosSimulator(device) || delayMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

export async function resolveCommandDevice(params: {
  session: SessionState | undefined;
  flags: DaemonRequest['flags'] | undefined;
  ensureReady?: boolean;
  allowStoppedAndroidAvdPlaceholders?: boolean;
}): Promise<DeviceInfo> {
  const shouldUseExplicitSelector = hasExplicitDeviceSelector(params.flags);
  const device =
    shouldUseExplicitSelector || !params.session
      ? await resolveTargetDevice(params.flags ?? {}, {
          allowStoppedAndroidAvdPlaceholders: params.allowStoppedAndroidAvdPlaceholders,
        })
      : await refreshSessionDeviceIfNeeded(params.session.device);
  if (params.ensureReady !== false) {
    await ensureDeviceReady(device);
  }
  return device;
}

export async function refreshSessionDeviceIfNeeded(device: DeviceInfo): Promise<DeviceInfo> {
  if (device.platform !== 'ios' || device.kind !== 'simulator') {
    return device;
  }
  if (process.platform !== 'darwin') {
    return device;
  }

  const exactSelector: NonNullable<DaemonRequest['flags']> = {
    platform: 'ios',
    target: device.target,
    udid: device.id,
    ...(device.simulatorSetPath ? { iosSimulatorDeviceSet: device.simulatorSetPath } : {}),
  };
  try {
    return await resolveTargetDevice(exactSelector);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'DEVICE_NOT_FOUND') {
      throw error;
    }
  }

  return await resolveTargetDevice({
    platform: 'ios',
    target: device.target,
    device: device.name,
    ...(device.simulatorSetPath ? { iosSimulatorDeviceSet: device.simulatorSetPath } : {}),
  });
}

export function resolveAndroidEmulatorAvdName(params: {
  flags: DaemonRequest['flags'] | undefined;
  sessionDevice?: DeviceInfo;
  resolvedDevice?: DeviceInfo;
}): string | undefined {
  const explicit = params.flags?.device?.trim();
  if (explicit) return explicit;
  if (params.resolvedDevice?.platform === 'android' && params.resolvedDevice.kind === 'emulator') {
    return params.resolvedDevice.name;
  }
  if (params.sessionDevice?.platform === 'android' && params.sessionDevice.kind === 'emulator') {
    return params.sessionDevice.name;
  }
  return undefined;
}

export function selectorTargetsSessionDevice(
  flags: DaemonRequest['flags'] | undefined,
  session: SessionState | undefined,
): boolean {
  if (!session) return false;
  return listSessionSelectorConflicts(session, flags).length === 0;
}
