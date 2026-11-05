import {
  resolveTargetDevice,
  resolveTargetDeviceSelection,
  type ResolveTargetDeviceOptions,
} from '@agent-device/device-selection/dispatch-resolve';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { DaemonRequest } from './daemon-request.ts';

type RequestTargetDeviceOptions = Omit<ResolveTargetDeviceOptions, 'webSession'>;
type RequestTargetDeviceFlags = Parameters<typeof resolveTargetDevice>[0];

/**
 * A web selection binds the web session the request scope derived, never the shared host, so a
 * web device resolved for a request without that identity is refused.
 */
function assertWebSelectionHasIdentity(req: DaemonRequest, device: DeviceInfo): void {
  if (device.platform !== 'web' || req.internal?.webSession !== undefined) return;
  throw new AppError('UNKNOWN', 'A web device was resolved outside a request scope.', {
    reason: 'request_web_session_missing',
  });
}

/** Resolves the device a request targets, with the request's own web session. */
export async function resolveRequestTargetDevice(
  req: DaemonRequest,
  options: RequestTargetDeviceOptions,
  flags: RequestTargetDeviceFlags = req.flags ?? {},
): ReturnType<typeof resolveTargetDevice> {
  const device = await resolveTargetDevice(flags, {
    ...options,
    webSession: req.internal?.webSession,
  });
  assertWebSelectionHasIdentity(req, device);
  return device;
}

export async function resolveRequestTargetDeviceSelection(
  req: DaemonRequest,
  options: RequestTargetDeviceOptions,
  flags: RequestTargetDeviceFlags = req.flags ?? {},
): ReturnType<typeof resolveTargetDeviceSelection> {
  const selection = await resolveTargetDeviceSelection(flags, {
    ...options,
    webSession: req.internal?.webSession,
  });
  assertWebSelectionHasIdentity(req, selection.device);
  return selection;
}
