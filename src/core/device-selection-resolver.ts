import type {
  DeviceSelectionMetadata,
  DeviceSelectionReason,
  DeviceSelectionSource,
} from '@agent-device/contracts/client';
import {
  hasExplicitDeviceIdentitySelector,
  isIosFamily,
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

export type InventoryDeviceSelectionParams = {
  devices: readonly DeviceInfo[];
  selector: DeviceSelector;
  source: InventoryDeviceSelectionSource;
  /**
   * The app target of an `open` against local inventory: when several booted
   * simulators match the selector, the one with the app installed wins.
   */
  appleSimulatorAppTarget?: string;
};

export async function resolveInventoryDeviceSelection(
  params: InventoryDeviceSelectionParams,
): Promise<DeviceSelectionResult> {
  const { devices, selector, source } = params;
  const explicitSelector = hasExplicitDeviceIdentitySelector(selector);

  if (source === 'provider' && !explicitSelector) {
    return resolveSingleProviderDevice(devices, selector);
  }
  if (source === 'local' && !explicitSelector) {
    const appMatch = await resolveAppInstalledSimulatorSelection(
      devices,
      selector,
      params.appleSimulatorAppTarget,
    );
    if (appMatch) return appMatch;
  }

  const candidates = devices.filter((device) =>
    matchesDeviceSelector(device, selector, { includeExplicitSelectors: explicitSelector }),
  );
  try {
    const device = await resolveDevice([...devices], selector);
    return describeSelection(device, candidates, { explicitSelector, source });
  } catch (error) {
    throw withDeviceRetrySelectors(error, candidates);
  }
}

export function resolveExistingSessionDeviceSelection(device: DeviceInfo): DeviceSelectionResult {
  return {
    device,
    reason: 'existing-session',
    source: 'session',
    candidateCount: 1,
    bootOccurred: false,
  };
}

/**
 * Open preparation owns lifecycle effects. Once it succeeds, a local virtual
 * target that was stopped at resolution has provided the requested boot event;
 * provider and physical targets never claim a daemon-owned boot.
 */
export function markSelectionBootOccurred(
  selection: DeviceSelectionResult | undefined,
): DeviceSelectionResult | undefined {
  if (!selection || selection.source !== 'local') return selection;
  const { device } = selection;
  const bootedByThisOpen =
    device.booted !== true && (device.kind === 'simulator' || device.kind === 'emulator');
  return bootedByThisOpen ? { ...selection, bootOccurred: true } : selection;
}

function describeSelection(
  device: DeviceInfo,
  candidates: readonly DeviceInfo[],
  context: { explicitSelector: boolean; source: InventoryDeviceSelectionSource },
): DeviceSelectionResult {
  return {
    device,
    reason: context.explicitSelector
      ? 'explicit-selector'
      : context.source === 'provider'
        ? 'single-provider-device'
        : resolveLocalReason(device, candidates),
    source: context.source,
    candidateCount: candidates.length,
    bootOccurred: false,
  };
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

async function resolveSingleProviderDevice(
  devices: readonly DeviceInfo[],
  selector: DeviceSelector,
): Promise<DeviceSelectionResult> {
  const candidates = devices.filter((device) => matchesDeviceSelector(device, selector));
  const onlyCandidate = candidates[0];
  if (onlyCandidate !== undefined && candidates.length === 1) {
    return describeSelection(onlyCandidate, candidates, {
      explicitSelector: false,
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

/**
 * Local app-affinity narrowing: with several booted simulators and no device
 * identity, exactly one simulator having the app installed is the deciding
 * fact, so it carries its own selected-by reason.
 */
async function resolveAppInstalledSimulatorSelection(
  devices: readonly DeviceInfo[],
  selector: DeviceSelector,
  appleSimulatorAppTarget: string | undefined,
): Promise<DeviceSelectionResult | undefined> {
  const appTarget = appleSimulatorAppTarget?.trim();
  if (!appTarget) return undefined;

  const bootedSimulators = devices.filter(
    (device) =>
      matchesDeviceSelector(device, selector) &&
      isIosFamily(device) &&
      device.kind === 'simulator' &&
      device.booted === true,
  );
  if (bootedSimulators.length < 2) return undefined;

  const { findIosSimulatorInstalledApp } = await import('../platforms/apple/core/apps.ts');
  const matches = (
    await Promise.all(
      bootedSimulators.map(async (device) =>
        (await findIosSimulatorInstalledApp(device, appTarget)) ? device : undefined,
      ),
    )
  ).filter((device): device is DeviceInfo => device !== undefined);

  const onlyMatch = matches[0];
  if (onlyMatch !== undefined && matches.length === 1) {
    return {
      device: onlyMatch,
      reason: 'single-app-installed-local',
      source: 'local',
      candidateCount: 1,
      bootOccurred: false,
    };
  }
  if (matches.length === 0) {
    throw new AppError('APP_NOT_INSTALLED', `No booted iOS simulator has ${appTarget} installed`, {
      appTarget,
      ...deviceCandidateDetails(bootedSimulators),
      hint: 'Install the app on a booted simulator, or pass --udid to select the intended device explicitly.',
      retrySelectors: retrySelectorsFor(bootedSimulators),
    });
  }
  throw new AppError(
    'AMBIGUOUS_MATCH',
    `Multiple booted iOS simulators have ${appTarget} installed`,
    {
      appTarget,
      ...deviceCandidateDetails(matches),
      hint: 'Pass --udid to select the intended simulator explicitly.',
      retrySelectors: retrySelectorsFor(matches),
    },
  );
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

/**
 * The device-domain candidate list. Keyed `devices`, not `candidates`: the find
 * handler's element matches own that key with an incompatible shape
 * (src/utils/error-candidates.ts).
 */
function deviceCandidateDetails(devices: readonly DeviceInfo[]) {
  return {
    devices: devices.slice(0, 10).map((device) => ({ id: device.id, name: device.name })),
  };
}

function retrySelectorsFor(devices: readonly DeviceInfo[]) {
  return devices.slice(0, 10).flatMap((device) => [
    {
      flag: isSerialAddressablePlatform(device.platform)
        ? ('--serial' as const)
        : ('--udid' as const),
      value: device.id,
    },
    { flag: '--device' as const, value: device.name },
  ]);
}
