import { inspectDeviceClaims } from '../device-claim-inspection.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';

/**
 * The fixtures the router-level `open` suites share: the device they pretend to resolve, the request
 * they send, and the claim stamp a claim suite reads back off disk. Each suite keeps its own handler
 * composition, because that is where its mocks are installed.
 */

export function makeIosDevice(id: string): DeviceInfo {
  return {
    platform: 'apple',
    id,
    name: `iPhone ${id}`,
    kind: 'simulator',
    target: 'mobile',
    booted: true,
  };
}

export function makeAndroidDevice(id: string): DeviceInfo {
  return {
    platform: 'android',
    id,
    name: `Android ${id}`,
    kind: 'emulator',
    target: 'mobile',
    booted: true,
  };
}

export function openRequest(
  session: string,
  flags: Record<string, unknown>,
  requestId: string,
  meta: Record<string, unknown> = {},
  positionals: string[] = [],
) {
  return {
    token: 'test-token',
    session,
    command: 'open',
    positionals,
    flags,
    meta: { requestId, ...meta },
  };
}

export function storedClaimUpdatedAt(device: DeviceInfo): number {
  const claim = inspectDeviceClaims({ udid: device.id })[0]?.claim;
  if (claim?.updatedAtMs === undefined) {
    throw new Error(`no device claim is stored for ${device.id}`);
  }
  return claim.updatedAtMs;
}
