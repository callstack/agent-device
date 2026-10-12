import {
  isIosFamily,
  isMacOs,
  matchesPlatformSelector,
  type DeviceInfo,
  type DeviceKind,
  type DeviceTarget,
  type Platform,
  type PlatformSelector,
} from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { ProviderDeviceInventorySource } from './device-provider.ts';

export const LOCAL_DEVICE_INVENTORY_PLATFORM_SELECTORS = [
  'android',
  'harmonyos',
  'apple',
  'vega',
  'linux',
] as const;

export type DeviceInventoryRequest = {
  platform?: PlatformSelector;
  target?: DeviceTarget;
  deviceName?: string;
  udid?: string;
  serial?: string;
  leaseId?: string;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
  iosSimulatorSetPath?: string;
  androidSerialAllowlist?: string[];
  /** Internal local-inventory projection filters; not public command grammar. */
  kind?: DeviceKind;
  booted?: boolean;
  /** Internal target-resolution policy; ordinary inventory leaves this absent and lists all AVDs. */
  androidAvdSelection?: 'running-only' | 'include-stopped';
};

export type ProviderDeviceInventoryRequest = Omit<DeviceInventoryRequest, 'booted' | 'kind'>;

export function projectProviderDeviceInventoryRequest(
  request: Readonly<DeviceInventoryRequest>,
): ProviderDeviceInventoryRequest {
  const { booted: _booted, kind: _kind, ...providerRequest } = request;
  return providerRequest;
}

export type DeviceInventoryGroup = 'android' | 'harmonyos' | 'apple' | 'vega' | 'linux' | 'web';
export type DeviceInventoryGroupCounts = Record<
  DeviceInventoryGroup,
  { available: number; booted: number }
>;

export const WEB_DESKTOP_DEVICE: DeviceInfo = {
  platform: 'web',
  id: 'agent-browser-chrome',
  name: 'Agent Browser Chrome',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

export function countDeviceInventoryByGroup(devices: DeviceInfo[]): DeviceInventoryGroupCounts {
  const counts = emptyDeviceInventoryGroupCounts();
  for (const device of devices) {
    const group = deviceInventoryGroupForDevice(device);
    counts[group].available += 1;
    if (device.booted === true) counts[group].booted += 1;
  }
  return counts;
}

/**
 * The composition-level contract every device-inventory source must honor: a family's
 * source only ever reports devices of its own family. Both the production composer and
 * the test fake enforce this through one implementation.
 */
export function assertSourceFamily(family: Platform, devices: readonly DeviceInfo[]): void {
  const outside = devices.find((device) => device.platform !== family);
  if (!outside) return;
  throw new AppError(
    'COMMAND_FAILED',
    `Platform inventory source ${family} returned a ${outside.platform} device.`,
    { expectedFamily: family, actualFamily: outside.platform, deviceId: outside.id },
  );
}

/**
 * Validates a raw provider discover result before the composer trusts it. A malformed
 * outcome (not a declined/inventory tagged object) is a provider contract violation, not
 * a local-inventory fallback.
 */
export function assertProviderOutcome(
  value: unknown,
): asserts value is Awaited<ReturnType<ProviderDeviceInventorySource['discover']>> {
  if (value !== null && typeof value === 'object') {
    const outcome = value as { kind?: unknown; devices?: unknown };
    if (outcome.kind === 'declined' && !('devices' in outcome)) return;
    if (outcome.kind === 'inventory' && Array.isArray(outcome.devices)) return;
  }
  throw new AppError('COMMAND_FAILED', 'Provider device inventory returned an invalid outcome.', {
    reason: 'provider_inventory_contract_violation',
  });
}

export function filterDeviceInventoryProjection(
  devices: readonly DeviceInfo[],
  request: Pick<DeviceInventoryRequest, 'platform' | 'target' | 'kind' | 'booted'>,
): DeviceInfo[] {
  return devices.filter(
    (device) =>
      matchesPlatformSelector(device, request.platform) &&
      (request.target === undefined || (device.target ?? 'mobile') === request.target) &&
      (request.kind === undefined || device.kind === request.kind) &&
      (request.booted === undefined || device.booted === request.booted),
  );
}

function emptyDeviceInventoryGroupCounts(): DeviceInventoryGroupCounts {
  return {
    android: { available: 0, booted: 0 },
    harmonyos: { available: 0, booted: 0 },
    apple: { available: 0, booted: 0 },
    vega: { available: 0, booted: 0 },
    linux: { available: 0, booted: 0 },
    web: { available: 0, booted: 0 },
  };
}

function deviceInventoryGroupForDevice(device: DeviceInfo): DeviceInventoryGroup {
  if (isIosFamily(device) || isMacOs(device)) return 'apple';
  return device.platform;
}

/**
 * The refusal reasons a host-local device claim can answer with when another owner holds the
 * device. Replay reads them to tell an infrastructure conflict from a script failure.
 */
export type DeviceClaimConflictReason =
  | 'DEVICE_CLAIM_LIVE_OWNER'
  | 'DEVICE_CLAIM_RECOVERY_PENDING'
  | 'DEVICE_CLAIM_OWNER_UNCERTAIN';

const DEVICE_CLAIM_CONFLICT_REASONS = new Set<DeviceClaimConflictReason>([
  'DEVICE_CLAIM_LIVE_OWNER',
  'DEVICE_CLAIM_RECOVERY_PENDING',
  'DEVICE_CLAIM_OWNER_UNCERTAIN',
]);

export function isDeviceClaimConflictReason(value: unknown): value is DeviceClaimConflictReason {
  return DEVICE_CLAIM_CONFLICT_REASONS.has(value as DeviceClaimConflictReason);
}
