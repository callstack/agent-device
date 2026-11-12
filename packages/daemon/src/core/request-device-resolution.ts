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
  const device = await resolveTargetDevice(await resolveRequestDeviceFlags(req, flags), {
    ...options,
    webSession: req.internal?.webSession,
  });
  assertWebSelectionHasIdentity(req, device);
  if (req.meta?.devicePin) {
    const { assertDeviceHonorsPin } =
      await import('@agent-device/device-selection/device-selection-resolver');
    assertDeviceHonorsPin(req.meta.devicePin, device, flags);
  }
  return device;
}

export async function resolveRequestTargetDeviceSelection(
  req: DaemonRequest,
  options: RequestTargetDeviceOptions,
  flags: RequestTargetDeviceFlags = req.flags ?? {},
): ReturnType<typeof resolveTargetDeviceSelection> {
  const selection = await resolveTargetDeviceSelection(
    await resolveRequestDeviceFlags(req, flags),
    {
      ...options,
      webSession: req.internal?.webSession,
    },
  );
  assertWebSelectionHasIdentity(req, selection.device);
  if (req.meta?.devicePin) {
    const { assertDeviceHonorsPin } =
      await import('@agent-device/device-selection/device-selection-resolver');
    assertDeviceHonorsPin(req.meta.devicePin, selection.device, flags);
  }
  return selection;
}

async function resolveRequestDeviceFlags(
  req: DaemonRequest,
  flags: RequestTargetDeviceFlags,
): Promise<RequestTargetDeviceFlags> {
  const pin = req.meta?.devicePin;
  if (pin) {
    const { effectiveDevicePinSelector } =
      await import('@agent-device/device-selection/device-selection-resolver');
    flags = { ...flags, ...effectiveDevicePinSelector(pin, flags) };
  }
  return {
    ...flags,
    ...resolveLeaseScope(req),
  };
}
