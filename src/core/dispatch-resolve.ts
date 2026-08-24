import type { CliFlags } from '@agent-device/contracts/command';
import type { DeviceInventoryRequest } from '@agent-device/contracts/device';
import {
  isApplePlatform,
  isIosFamily,
  matchesDeviceSelector,
  resolveAppleSimulatorSetPathForSelector,
  type DeviceInfo,
  type DeviceTarget,
  type PlatformSelector,
} from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  resolveAndroidSerialAllowlist,
  resolveIosSimulatorDeviceSetPath,
} from '../utils/device-isolation.ts';
import { withDiagnosticTimer } from '../utils/diagnostics.ts';
import {
  listLocalDeviceInventory,
  readDeviceInventory,
  shouldPropagateDeviceInventoryProbeError,
} from '../request/device-inventory-context.ts';
import {
  buildDeviceSelectionResult,
  resolveInventoryDeviceSelection,
  type DeviceSelectionResult,
} from './device-selection-resolver.ts';
export type ResolveDeviceFlags = Pick<
  CliFlags,
  | 'platform'
  | 'target'
  | 'device'
  | 'udid'
  | 'serial'
  | 'leaseId'
  | 'iosSimulatorDeviceSet'
  | 'androidDeviceAllowlist'
> & {
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
};

const resolveTargetDeviceCacheScope = new AsyncLocalStorage<Map<string, DeviceSelectionResult>>();

export type { DeviceInventoryRequest };

type AppleDeviceSelector = {
  platform?: 'ios' | 'macos' | 'apple';
  target?: DeviceTarget;
  deviceName?: string;
  udid?: string;
  serial?: string;
};

export type ResolveTargetDeviceOptions = {
  androidAvdSelection?: 'running-only' | 'include-stopped';
  appleSimulatorAppTarget?: string;
};

async function findBootedAppleSimulatorWithApp(
  devices: DeviceInfo[],
  selector: AppleDeviceSelector,
  context: {
    allowLocalSimulatorFallback?: boolean;
    appleSimulatorAppTarget?: string;
  },
): Promise<DeviceInfo | undefined> {
  const appTarget = context.appleSimulatorAppTarget?.trim();
  if (!appTarget || hasExplicitAppleDeviceSelector(selector)) return undefined;
  if (context.allowLocalSimulatorFallback === false) return undefined;

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

  if (matches.length === 1) return matches[0];

  if (matches.length === 0) {
    throw new AppError('APP_NOT_INSTALLED', `No booted iOS simulator has ${appTarget} installed`, {
      appTarget,
      ...deviceCandidateDetails(bootedSimulators),
      hint: 'Install the app on a booted simulator, or pass --udid to select the intended device explicitly.',
    });
  }

  throw new AppError(
    'AMBIGUOUS_MATCH',
    `Multiple booted iOS simulators have ${appTarget} installed`,
    {
      appTarget,
      ...deviceCandidateDetails(matches),
      hint: 'Pass --udid to select the intended simulator explicitly.',
    },
  );
}

/**
 * The device-domain candidate list. Keyed `devices`, not `candidates`: the find
 * handler's element matches own that key with an incompatible shape
 * (src/utils/error-candidates.ts).
 */
function deviceCandidateDetails(devices: DeviceInfo[]) {
  return {
    devices: devices.map((device) => ({ id: device.id, name: device.name })),
    retrySelectors: devices.slice(0, 10).map((device) => ({
      flag: '--udid' as const,
      value: device.id,
    })),
  };
}

function canFallbackAfterAppleDeviceNotFound(
  error: unknown,
  selector: AppleDeviceSelector,
): boolean {
  return (
    !hasExplicitAppleDeviceSelector(selector) &&
    error instanceof AppError &&
    error.code === 'DEVICE_NOT_FOUND'
  );
}

function shouldUseAppleSimulatorFallback(
  selector: AppleDeviceSelector,
  selected: DeviceInfo | undefined,
): boolean {
  return (
    !hasExplicitAppleDeviceSelector(selector) &&
    (!selector.platform || selector.platform === 'apple' || selector.platform === 'ios') &&
    selector.target !== 'desktop' &&
    (!selected || selected.kind === 'device')
  );
}

function hasExplicitAppleDeviceSelector(selector: AppleDeviceSelector): boolean {
  return Boolean(selector.udid || selector.serial || selector.deviceName);
}

export async function resolveTargetDevice(
  flags: ResolveDeviceFlags,
  options: ResolveTargetDeviceOptions = {},
): Promise<DeviceInfo> {
  return (await resolveTargetDeviceSelection(flags, options)).device;
}

export async function resolveTargetDeviceSelection(
  flags: ResolveDeviceFlags,
  options: ResolveTargetDeviceOptions = {},
): Promise<DeviceSelectionResult> {
  const inventoryRequest = {
    ...buildDeviceInventoryRequestFromFlags(flags),
    androidAvdSelection: options.androidAvdSelection ?? 'running-only',
  };
  const { iosSimulatorSetPath, ...selector } = inventoryRequest;
  const cacheKey = buildResolveTargetDeviceCacheKey(inventoryRequest, options);
  const diagnosticData = {
    platform: inventoryRequest.platform,
    target: flags.target,
    cacheHit: false,
  };
  return await withDiagnosticTimer(
    'resolve_target_device',
    async () => {
      const cached = readResolveTargetDeviceCache(cacheKey);
      if (cached) {
        diagnosticData.cacheHit = true;
        return cached;
      }
      const inventory = await readDeviceInventory(inventoryRequest);
      const devices = [...inventory.devices];
      const explicitSelector = hasExplicitDeviceSelector(flags);

      if (shouldUseAppleResolution(selector)) {
        const selection = await resolveAppleDeviceSelection(
          devices,
          selector as AppleDeviceSelector,
          {
            simulatorSetPath: iosSimulatorSetPath,
            allowLocalSimulatorFallback: inventory.source === 'local',
            appleSimulatorAppTarget: options.appleSimulatorAppTarget,
            source: inventory.source,
            explicitSelector,
          },
        );
        return cacheResolvedTargetDevice(cacheKey, selection);
      }

      return cacheResolvedTargetDevice(
        cacheKey,
        await resolveInventoryDeviceSelection({
          devices,
          selector,
          source: inventory.source,
          explicitSelector,
        }),
      );
    },
    diagnosticData,
  );
}

async function resolveAppleDeviceSelection(
  devices: DeviceInfo[],
  selector: AppleDeviceSelector,
  context: {
    simulatorSetPath?: string;
    allowLocalSimulatorFallback?: boolean;
    appleSimulatorAppTarget?: string;
    source: 'local' | 'provider';
    explicitSelector: boolean;
  },
): Promise<DeviceSelectionResult> {
  if (context.source === 'provider' && !context.explicitSelector) {
    return await resolveInventoryDeviceSelection({
      devices,
      selector,
      source: 'provider',
      explicitSelector: false,
    });
  }

  const appMatchedSimulator = await findBootedAppleSimulatorWithApp(devices, selector, context);
  if (appMatchedSimulator) {
    return buildAppleDeviceSelection(appMatchedSimulator, devices, selector, context);
  }

  const selected = await resolveAppleInventoryCandidate(devices, selector, context);
  const simulatorFallback = await resolveAppleSimulatorFallback(selector, context, selected);
  if (simulatorFallback) return simulatorFallback;
  if (selected) return buildAppleDeviceSelection(selected, devices, selector, context);
  throw new AppError('DEVICE_NOT_FOUND', 'No devices found', { selector });
}

async function resolveAppleInventoryCandidate(
  devices: DeviceInfo[],
  selector: AppleDeviceSelector,
  context: {
    source: 'local' | 'provider';
    explicitSelector: boolean;
  },
): Promise<DeviceInfo | undefined> {
  try {
    return (
      await resolveInventoryDeviceSelection({
        devices,
        selector,
        source: context.source,
        explicitSelector: context.explicitSelector,
      })
    ).device;
  } catch (error) {
    if (canFallbackAfterAppleDeviceNotFound(error, selector)) return undefined;
    throw error;
  }
}

async function resolveAppleSimulatorFallback(
  selector: AppleDeviceSelector,
  context: {
    simulatorSetPath?: string;
    allowLocalSimulatorFallback?: boolean;
  },
  selected: DeviceInfo | undefined,
): Promise<DeviceSelectionResult | undefined> {
  if (
    context.allowLocalSimulatorFallback === false ||
    !shouldUseAppleSimulatorFallback(selector, selected)
  ) {
    return undefined;
  }
  try {
    const localDevices = await listLocalDeviceInventory({
      platform: selector.platform ?? 'ios',
      target: selector.target,
      iosSimulatorSetPath: context.simulatorSetPath,
      kind: 'simulator',
    });
    return await resolveInventoryDeviceSelection({
      devices: localDevices,
      selector,
      source: 'local',
      explicitSelector: false,
    });
  } catch (error) {
    if (shouldPropagateDeviceInventoryProbeError(error)) throw error;
    return undefined;
  }
}

function buildAppleDeviceSelection(
  device: DeviceInfo,
  devices: DeviceInfo[],
  selector: AppleDeviceSelector,
  context: {
    source: 'local' | 'provider';
    explicitSelector: boolean;
  },
): DeviceSelectionResult {
  return buildDeviceSelectionResult({
    device,
    devices,
    selector,
    source: context.source,
    explicitSelector: context.explicitSelector,
  });
}

function hasExplicitDeviceSelector(flags: ResolveDeviceFlags): boolean {
  return [flags.platform, flags.target, flags.device, flags.udid, flags.serial].some(
    (value) => typeof value === 'string' && value.trim().length > 0,
  );
}

export function buildDeviceInventoryRequestFromFlags(
  flags: ResolveDeviceFlags,
): DeviceInventoryRequest {
  const platform = flags.platform;
  if (flags.target && !platform) {
    throw new AppError(
      'INVALID_ARGS',
      'Device target selector requires --platform. Use --platform ios|macos|android|vega|linux|apple with --target mobile|tv|desktop.',
    );
  }
  const iosSimulatorSetPath = resolveAppleSimulatorSetPathForSelector({
    simulatorSetPath: resolveIosSimulatorDeviceSetPath(flags.iosSimulatorDeviceSet),
    platform,
    target: flags.target,
  });
  const androidSerialAllowlist = resolveAndroidSerialAllowlist(flags.androidDeviceAllowlist);
  return {
    platform,
    target: flags.target,
    deviceName: flags.device,
    udid: flags.udid,
    serial: flags.serial,
    leaseId: flags.leaseId,
    leaseProvider: flags.leaseProvider,
    deviceKey: flags.deviceKey,
    clientId: flags.clientId,
    iosSimulatorSetPath,
    androidSerialAllowlist: androidSerialAllowlist
      ? Array.from(androidSerialAllowlist).sort()
      : undefined,
  };
}

export async function withResolveTargetDeviceCacheScope<T>(task: () => Promise<T>): Promise<T> {
  if (resolveTargetDeviceCacheScope.getStore()) return await task();
  return await resolveTargetDeviceCacheScope.run(new Map(), task);
}

function isAppleResolutionSelector(selector: {
  platform?: PlatformSelector;
  target?: DeviceTarget;
}): boolean {
  return isApplePlatform(selector.platform);
}

function shouldUseAppleResolution(selector: {
  platform?: PlatformSelector;
  target?: DeviceTarget;
}): boolean {
  return isAppleResolutionSelector(selector);
}

function readResolveTargetDeviceCache(cacheKey: string): DeviceSelectionResult | undefined {
  const cache = resolveTargetDeviceCacheScope.getStore();
  const cached = cache?.get(cacheKey);
  if (!cached) return undefined;
  return { ...cached, device: { ...cached.device } };
}

function cacheResolvedTargetDevice(
  cacheKey: string,
  selection: DeviceSelectionResult,
): DeviceSelectionResult {
  resolveTargetDeviceCacheScope.getStore()?.set(cacheKey, {
    ...selection,
    device: { ...selection.device },
  });
  return selection;
}

function buildResolveTargetDeviceCacheKey(
  request: DeviceInventoryRequest,
  options: ResolveTargetDeviceOptions,
): string {
  // The app target only informs the first device choice. Once a request has
  // chosen a device, every later resolution must reuse that same device even
  // when dispatch has no app target to pass back through this seam.
  const { appleSimulatorAppTarget: _appleSimulatorAppTarget, ...cacheOptions } = options;
  return JSON.stringify({ request, options: cacheOptions });
}
