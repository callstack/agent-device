import {
  isIosFamily,
  isMacOs,
  matchesPlatformSelector,
  type DeviceInfo,
  type DeviceKind,
  type DeviceTarget,
  type PlatformSelector,
} from '@agent-device/kernel/device';

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
