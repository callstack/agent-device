import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { isActiveProviderDevice } from '../../provider-device-runtime.ts';
import { ensureDeviceReady } from '../device-ready.ts';
import { getRunnerSessionSnapshot } from '../../platforms/apple/core/runner/runner-client.ts';
import { resolveTargetDevice } from '../../core/dispatch.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { hasDeviceSelectionInput, hasExplicitDeviceSelector } from '../device-selector-intent.ts';
import { listSessionSelectorConflicts } from '../session-selector.ts';
import { isIosSimulator } from '../device-targets.ts';
import { errorResponse } from './response.ts';

export { isIosSimulator };

export function requireSessionOrExplicitSelector(
  command: string,
  session: SessionState | undefined,
  flags: DaemonRequest['flags'] | undefined,
): DaemonResponse | null {
  if (session || hasDeviceSelectionInput(flags)) {
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

export async function resolveCommandDevice(params: {
  session: SessionState | undefined;
  flags: DaemonRequest['flags'] | undefined;
  ensureReady?: boolean;
  androidAvdSelection?: 'running-only' | 'include-stopped';
}): Promise<DeviceInfo> {
  const shouldUseExplicitIdentity = hasExplicitDeviceSelector(params.flags);
  const device =
    shouldUseExplicitIdentity || !params.session
      ? await resolveTargetDevice(params.flags ?? {}, {
          androidAvdSelection: params.androidAvdSelection,
        })
      : await refreshSessionDeviceIfNeeded(params.session.device);
  if (params.ensureReady !== false) {
    await ensureDeviceReady(device);
  }
  return device;
}

export async function refreshSessionDeviceIfNeeded(device: DeviceInfo): Promise<DeviceInfo> {
  if (isActiveProviderDevice(device)) {
    return device;
  }
  if (!isIosFamily(device) || device.kind !== 'simulator') {
    return device;
  }
  if (process.platform !== 'darwin') {
    return device;
  }
  // A live XCUITest runner session is attached to this exact UDID, which
  // proves the simulator still exists and is booted — the two facts the
  // ~0.7s re-resolve inventory listing exists to establish.
  if (getRunnerSessionSnapshot(device.id)?.alive) {
    return { ...device, booted: true };
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

export function selectorTargetsSessionDevice(
  flags: DaemonRequest['flags'] | undefined,
  session: SessionState | undefined,
): boolean {
  if (!session) return false;
  return listSessionSelectorConflicts(session, flags).length === 0;
}
