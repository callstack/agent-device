import {
  resolveTargetDevice,
  resolveTargetDeviceSelection,
  type ResolveTargetDeviceOptions,
} from '@agent-device/device-selection/dispatch-resolve';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DaemonRequest } from './daemon-request.ts';
import { resolveLeaseScope } from './lease-context.ts';
import { requestWebSession } from './session-tenant-scope.ts';

type RequestTargetDeviceOptions = Omit<ResolveTargetDeviceOptions, 'webSession'>;
type RequestTargetDeviceFlags = Parameters<typeof resolveTargetDevice>[0];

/**
 * A web selection binds the web session the request scope derived, never the shared host, so a
 * web device resolved for a request without that identity is refused.
 */
function assertWebSelectionHasIdentity(req: DaemonRequest, device: DeviceInfo): void {
  if (device.platform === 'web') requestWebSession(req);
}

/** Resolves the device a request targets, with the request's own web session. */
export async function resolveRequestTargetDevice(
  req: DaemonRequest,
  options: RequestTargetDeviceOptions,
  flags: RequestTargetDeviceFlags = req.flags ?? {},
): ReturnType<typeof resolveTargetDevice> {
  const device = await resolveTargetDevice(
    { ...flags, ...resolveLeaseScope(req) },
    {
      ...options,
      webSession: req.internal?.webSession,
    },
  );
  assertWebSelectionHasIdentity(req, device);
  return device;
}

export async function resolveRequestTargetDeviceSelection(
  req: DaemonRequest,
  options: RequestTargetDeviceOptions,
  flags: RequestTargetDeviceFlags = req.flags ?? {},
): ReturnType<typeof resolveTargetDeviceSelection> {
  const selection = await resolveTargetDeviceSelection(
    { ...flags, ...resolveLeaseScope(req) },
    {
      ...options,
      webSession: req.internal?.webSession,
    },
  );
  assertWebSelectionHasIdentity(req, selection.device);
  return selection;
}
