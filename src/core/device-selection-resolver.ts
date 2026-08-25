import type {
  DeviceSelectionMetadata,
  DeviceSelectionReason,
  DeviceSelectionRetrySelector,
  DeviceSelectionSource,
} from '@agent-device/contracts/client';
import {
  hasExplicitDeviceIdentitySelector,
  isSerialAddressablePlatform,
  matchesDeviceSelector,
  resolveDevice,
  type DeviceInfo,
  type DeviceSelector,
} from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

export type DeviceSelectionResult = DeviceSelectionMetadata & {
  device: DeviceInfo;
};

export type InventoryDeviceSelectionSource = Exclude<DeviceSelectionSource, 'session'>;

export async function resolveInventoryDeviceSelection(params: {
  devices: readonly DeviceInfo[];
  selector: DeviceSelector;
  source: InventoryDeviceSelectionSource;
  selectedDevice?: DeviceInfo;
  allowBootableLocal?: boolean;
}): Promise<DeviceSelectionResult> {
  const { devices, selector, source } = params;
  const explicitSelector = hasExplicitDeviceIdentitySelector(selector);
  const allowBootableLocal = params.allowBootableLocal ?? true;
  const eligibleDevices =
    explicitSelector || source === 'provider' || allowBootableLocal
      ? [...devices]
      : devices.filter((device) => device.booted === true);

  if (source === 'provider' && !hasExplicitProviderIdentity(selector)) {
    return resolveSingleProviderDevice(eligibleDevices, selector);
  }

  const candidates = eligibleDevices.filter((device) =>
    matchesDeviceSelector(device, selector, { includeExplicitSelectors: explicitSelector }),
  );
  try {
    const device = params.selectedDevice ?? (await resolveDevice(eligibleDevices, selector));
    return buildDeviceSelectionResult({
      device,
      devices: eligibleDevices,
      selector,
      source,
    });
  } catch (error) {
    throw withDeviceRetrySelectors(error, candidates);
  }
}

function buildDeviceSelectionResult(params: {
  device: DeviceInfo;
  devices: readonly DeviceInfo[];
  selector: DeviceSelector;
  source: InventoryDeviceSelectionSource;
}): DeviceSelectionResult {
  const { device, devices, selector, source } = params;
  const explicitSelector = hasExplicitDeviceIdentitySelector(selector);
  const candidates = devices.filter((candidate) =>
    matchesDeviceSelector(candidate, selector, { includeExplicitSelectors: explicitSelector }),
  );
  return {
    device,
    reason: explicitSelector
      ? 'explicit-selector'
      : source === 'provider'
        ? 'single-provider-device'
        : resolveLocalReason(device, candidates),
    source,
    candidateCount: candidates.length,
    booted: device.booted === true,
    bootOccurred: false,
  };
}

function hasExplicitProviderIdentity(selector: DeviceSelector): boolean {
  return hasExplicitDeviceIdentitySelector(selector);
}

export function resolveExistingSessionDeviceSelection(device: DeviceInfo): DeviceSelectionResult {
  return {
    device,
    reason: 'existing-session',
    source: 'session',
    candidateCount: 1,
    booted: device.booted === true,
    bootOccurred: false,
  };
}

/**
 * Open preparation owns lifecycle effects. Once it succeeds, a local virtual
 * target that was stopped at resolution has provided the requested boot event;
 * provider and physical targets never claim a daemon-owned boot.
 */
export function markSelectionBootedAfterPreparation(
  selection: DeviceSelectionResult | undefined,
): DeviceSelectionResult | undefined {
  if (!selection) return undefined;
  const requiresLocalVirtualBoot =
    selection.source === 'local' &&
    !selection.booted &&
    (selection.device.kind === 'simulator' || selection.device.kind === 'emulator');
  return {
    ...selection,
    booted: selection.booted || requiresLocalVirtualBoot,
    bootOccurred: selection.bootOccurred || requiresLocalVirtualBoot,
  };
}

async function resolveSingleProviderDevice(
  devices: readonly DeviceInfo[],
  selector: DeviceSelector,
): Promise<DeviceSelectionResult> {
  const candidates = devices.filter((device) => matchesDeviceSelector(device, selector));
  if (candidates.length === 1) {
    const device = candidates[0]!;
    return buildDeviceSelectionResult({
      device,
      devices,
      selector,
      source: 'provider',
    });
  }

  try {
    // Let the kernel own its typed no-candidate error and selector validation.
    await resolveDevice([...devices], selector);
  } catch (error) {
    throw withDeviceRetrySelectors(error, candidates);
  }
  throw new AppError('AMBIGUOUS_MATCH', 'Multiple provider devices match this request.', {
    ...deviceCandidateDetails(candidates),
    matches: candidates.length,
    hint: 'Select the leased provider device explicitly with --device, --udid, or --serial.',
    retrySelectors: retrySelectorsFor(candidates),
  });
}

function resolveLocalReason(
  device: DeviceInfo,
  candidates: readonly DeviceInfo[],
): DeviceSelectionReason {
  if (
    device.booted === true &&
    candidates.filter((candidate) => candidate.booted === true).length === 1
  ) {
    return 'single-booted-local';
  }
  if (!device.booted && candidates.length === 1) return 'single-bootable-local';
  return 'preferred-local';
}

function withDeviceRetrySelectors(error: unknown, candidates: readonly DeviceInfo[]): unknown {
  if (!(error instanceof AppError) || error.code !== 'AMBIGUOUS_MATCH') return error;
  return new AppError(
    error.code,
    error.message,
    {
      ...(error.details ?? {}),
      ...deviceCandidateDetails(candidates),
      retrySelectors: retrySelectorsFor(candidates),
    },
    error,
  );
}

function deviceCandidateDetails(devices: readonly DeviceInfo[]) {
  return {
    devices: devices.slice(0, 10).map((device) => ({ id: device.id, name: device.name })),
  };
}

function retrySelectorsFor(devices: readonly DeviceInfo[]): DeviceSelectionRetrySelector[] {
  return devices.slice(0, 10).flatMap((device) => [
    {
      flag: isSerialAddressablePlatform(device.platform) ? '--serial' : '--udid',
      value: device.id,
    },
    { flag: '--device', value: device.name },
  ]);
}
