import type { DevicePin, DevicePinSelector } from '@agent-device/contracts/device';
import type {
  DeviceSelectionMetadata,
  DeviceSelectionReason,
  DeviceSelectionSource,
} from '@agent-device/contracts/client';
import {
  hasExplicitDeviceIdentitySelector,
  isApplePlatform,
  isIosFamily,
  isSerialAddressablePlatform,
  matchesDeviceSelector,
  matchesDeviceNameSelector,
  platformSelectorsConflict,
  preferredDeviceCandidates,
  type PlatformSelector,
  pickNewestBootableDevice,
  resolveDevice,
  type BootPickPolicy,
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
  /** Set only by `boot`, the one command that may settle a tie between shut-down local devices. */
  boot?: BootSelectionIntent;
};

/** A boot request. `pick` is its `--pick` opt-in; without it, a shut-down tie names the opt-in. */
export type BootSelectionIntent = { pick?: BootPickPolicy };

const BOOT_PICK_HINT =
  'To boot one of these shut-down devices, pass --pick newest (pick: "newest" from Node or MCP).';

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
  const bootPickable =
    params.boot && source === 'local' && !explicitSelector
      ? pickNewestBootableDevice(candidates)
      : undefined;
  if (bootPickable && params.boot?.pick === 'newest') {
    return {
      device: bootPickable,
      reason: 'newest-bootable-local',
      source,
      candidateCount: candidates.length,
      bootOccurred: false,
    };
  }
  try {
    const device = await resolveDevice([...devices], selector);
    return describeSelection(device, candidates, { explicitSelector, source });
  } catch (error) {
    throw withDeviceRetrySelectors(error, candidates, bootPickable ? BOOT_PICK_HINT : undefined);
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
  selection: DeviceSelectionResult,
  localPreparation?: boolean,
): DeviceSelectionResult;
export function markSelectionBootOccurred(
  selection: DeviceSelectionResult | undefined,
  localPreparation?: boolean,
): DeviceSelectionResult | undefined;
export function markSelectionBootOccurred(
  selection: DeviceSelectionResult | undefined,
  localPreparation = selection?.source === 'local',
): DeviceSelectionResult | undefined {
  if (!selection || !localPreparation || selection.source === 'provider') return selection;
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
    dispatched: 'no',
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

  // Function-scoped: keeps the request-context module out of this entry's eager closure.
  const { readInstalledAppProbe } = await import('./device-inventory-context.ts');
  const findInstalledApp = readInstalledAppProbe();
  if (!findInstalledApp) return undefined;

  const bootedSimulators = devices.filter(
    (device) =>
      matchesDeviceSelector(device, selector) &&
      isIosFamily(device) &&
      device.kind === 'simulator' &&
      device.booted === true,
  );
  if (bootedSimulators.length < 2) return undefined;

  const matches = (
    await Promise.all(
      bootedSimulators.map(async (device) =>
        (await findInstalledApp(device, appTarget)) ? device : undefined,
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
      dispatched: 'no',
      hint: 'Pass --udid to select the intended simulator explicitly.',
      retrySelectors: retrySelectorsFor(matches),
    },
  );
}

function withDeviceRetrySelectors(
  error: unknown,
  candidates: readonly DeviceInfo[],
  extraHint?: string,
): unknown {
  if (!(error instanceof AppError) || error.code !== 'AMBIGUOUS_MATCH') return error;
  // The kernel refuses only its equally preferred devices; a lower-ranked or shut-down match is
  // no answer to the tie, so only the tied devices become retry selectors.
  const tied = preferredDeviceCandidates([...candidates]);
  return new AppError(
    error.code,
    error.message,
    {
      ...(error.details ?? {}),
      ...deviceCandidateDetails(tied),
      retrySelectors: retrySelectorsFor(tied),
      ...(extraHint ? { hint: [error.details?.hint, extraHint].filter(Boolean).join(' ') } : {}),
    },
    error,
  );
}

/**
 * The device-domain candidate list. Keyed `devices`, not `candidates`: the find
 * handler's element matches own that key with an incompatible shape
 * (@agent-device/kernel/errors).
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

type PinConflict = {
  key: keyof DevicePinSelector;
  pinnedKey?: keyof DevicePinSelector;
  pinned: string;
  requested: string;
  step?: number;
};

function devicePinSourceLabel(source: DevicePin['source']): string {
  return `${source.kind === 'project' ? 'project ' : ''}config file ${source.path}`;
}

export function effectiveDevicePinSelector(
  pin: DevicePin,
  requested: DevicePinSelector,
): DevicePinSelector {
  const platform = requested.platform;
  return {
    platform: platform && platform !== 'apple' ? platform : (pin.selector.platform ?? platform),
    device: requested.device ?? pin.selector.device,
    udid: requested.udid ?? pin.selector.udid,
    serial: requested.serial ?? pin.selector.serial,
  };
}

export function assertRequestHonorsDevicePin(
  pin: DevicePin,
  request: {
    flags?: Readonly<Record<string, unknown>> & {
      batchSteps?: ReadonlyArray<{ flags?: Readonly<Record<string, unknown>> }>;
    };
  },
): void {
  const conflicts: PinConflict[] = [];
  const collect = (flags: Readonly<Record<string, unknown>> | undefined, step?: number) => {
    const location = step === undefined ? {} : { step };
    for (const pinnedKey of Object.keys(pin.selector) as Array<keyof DevicePinSelector>) {
      const pinned = pin.selector[pinnedKey];
      if (pinned === undefined) continue;
      for (const key of ['platform', 'device', 'udid', 'serial'] as const) {
        const requested = flags?.[key];
        if (
          typeof requested === 'string' &&
          pinSelectorsConflict(pinnedKey, pinned, key, requested)
        ) {
          conflicts.push({
            key,
            pinned,
            requested,
            ...(key === pinnedKey ? {} : { pinnedKey }),
            ...location,
          });
        }
      }
    }
  };
  collect(request.flags);
  request.flags?.batchSteps?.forEach((step, index) => collect(step.flags, index + 1));
  if (conflicts.length) throwPinConflict(pin, conflicts);
}

function pinSelectorsConflict(
  pinnedKey: keyof DevicePinSelector,
  pinned: string,
  key: keyof DevicePinSelector,
  requested: string,
): boolean {
  if (pinnedKey === key) {
    if (key === 'device') return !matchesDeviceNameSelector({ name: pinned }, requested);
    if (key === 'platform')
      return platformSelectorsConflict(requested as PlatformSelector, pinned as PlatformSelector);
    return requested !== pinned;
  }
  if (pinnedKey === 'platform') return !selectorSupportsPlatform(key, pinned as PlatformSelector);
  if (key === 'platform')
    return !selectorSupportsPlatform(pinnedKey, requested as PlatformSelector);
  return (pinnedKey === 'udid' && key === 'serial') || (pinnedKey === 'serial' && key === 'udid');
}

function selectorSupportsPlatform(
  key: keyof DevicePinSelector,
  platform: PlatformSelector,
): boolean {
  if (key === 'udid') return isApplePlatform(platform);
  if (key === 'serial') return isSerialAddressablePlatform(platform);
  return true;
}

export function assertDeviceHonorsPin(
  pin: DevicePin,
  device: DeviceInfo,
  requested: DevicePinSelector = {},
): void {
  const matches = (selector: DevicePinSelector) =>
    matchesDeviceSelector(
      device,
      { ...selector, deviceName: selector.device },
      { includeExplicitSelectors: true },
    );
  if (matches(pin.selector) && matches(requested)) return;
  throwPinConflict(pin, [], { id: device.id, name: device.name });
}

function throwPinConflict(
  pin: DevicePin,
  conflicts: PinConflict[],
  device?: { id: string; name: string },
): never {
  const first = conflicts[0];
  const where = first?.step === undefined ? '' : `Batch step ${first.step}: `;
  const requested = first
    ? `${first.key} ${JSON.stringify(first.requested)}`
    : `Device selection ${JSON.stringify(device?.name)} (${device?.id})`;
  const source = devicePinSourceLabel(pin.source);
  throw new AppError(
    'INVALID_ARGS',
    `${where}${requested} conflicts with the device pin from ${source}.`,
    {
      reason: 'device_pin_conflict',
      pin: { ...pin.selector },
      pinSource: source,
      conflicts,
      ...(device ? { device } : {}),
      hint: `Use a device matching ${JSON.stringify(pin.selector)}, or edit or remove devicePin in ${pin.source.path}.`,
    },
  );
}
