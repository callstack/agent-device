import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError } from '../kernel/errors.ts';
import {
  isApplePlatform,
  isIosFamily,
  matchesDeviceSelector,
  resolveDevice,
  resolveAppleSimulatorSetPathForSelector,
  type DeviceInfo,
  type DeviceTarget,
  type PlatformSelector,
} from '../kernel/device.ts';
import { withDiagnosticTimer } from '../utils/diagnostics.ts';
import {
  resolveAndroidSerialAllowlist,
  resolveIosSimulatorDeviceSetPath,
} from '../utils/device-isolation.ts';
import type { CliFlags } from '../contracts/cli-flags.ts';
import type { DeviceInventoryRequest } from '../contracts/device-inventory.ts';
import { listLocalDeviceInventory } from './platform-inventory.ts';
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

const resolveTargetDeviceCacheScope = new AsyncLocalStorage<Map<string, DeviceInfo>>();
const deviceInventoryProviderScope = new AsyncLocalStorage<DeviceInventoryProvider>();

export type { DeviceInventoryRequest };

export type DeviceInventoryProvider = (
  request: DeviceInventoryRequest,
) => Promise<DeviceInfo[] | null | undefined>;

type AppleDeviceSelector = {
  platform?: 'ios' | 'macos' | 'apple';
  target?: DeviceTarget;
  deviceName?: string;
  udid?: string;
  serial?: string;
};

export type ResolveTargetDeviceOptions = {
  allowStoppedAndroidAvdPlaceholders?: boolean;
  appleSimulatorAppTarget?: string;
};

/**
 * Resolves the best iOS device given pre-fetched candidates.  When no explicit
 * device selector was used, physical devices are rejected in favour of a
 * bootable simulator discovered via `findBootableSimulator`.
 *
 * Exported for testing; production callers should use `resolveTargetDevice`.
 */
async function resolveAppleDevice(
  devices: DeviceInfo[],
  selector: AppleDeviceSelector,
  context: {
    simulatorSetPath?: string;
    allowLocalSimulatorFallback?: boolean;
    appleSimulatorAppTarget?: string;
  },
): Promise<DeviceInfo> {
  const appMatchedSimulator = await findBootedAppleSimulatorWithApp(devices, selector, context);
  if (appMatchedSimulator) return appMatchedSimulator;

  const selected = await resolveAppleDeviceCandidate(devices, selector, context);

  if (
    context.allowLocalSimulatorFallback !== false &&
    shouldUseAppleSimulatorFallback(selector, selected)
  ) {
    const { findBootableIosSimulator } = await import('../platforms/apple/core/devices.ts');
    const simulator = await findBootableIosSimulator({
      simulatorSetPath: context.simulatorSetPath,
      target: selector.target,
    });
    if (simulator) return simulator;
  }

  if (selected) return selected;
  throw new AppError('DEVICE_NOT_FOUND', 'No devices found', { selector });
}

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

  const candidates = bootedSimulators.map((device) => ({
    id: device.id,
    name: device.name,
  }));
  if (matches.length === 0) {
    throw new AppError('APP_NOT_INSTALLED', `No booted iOS simulator has ${appTarget} installed`, {
      appTarget,
      candidates,
      hint: 'Install the app on a booted simulator, or pass --udid to select the intended device explicitly.',
    });
  }

  throw new AppError(
    'AMBIGUOUS_MATCH',
    `Multiple booted iOS simulators have ${appTarget} installed`,
    {
      appTarget,
      candidates: matches.map((device) => ({ id: device.id, name: device.name })),
      hint: 'Pass --udid to select the intended simulator explicitly.',
    },
  );
}

async function resolveAppleDeviceCandidate(
  devices: DeviceInfo[],
  selector: AppleDeviceSelector,
  context: { simulatorSetPath?: string },
): Promise<DeviceInfo | undefined> {
  try {
    return await resolveDevice(devices, selector, context);
  } catch (error) {
    if (canFallbackAfterAppleDeviceNotFound(error, selector)) return undefined;
    throw error;
  }
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
  const inventoryRequest = buildDeviceInventoryRequestFromFlags(flags);
  const { iosSimulatorSetPath, ...selector } = inventoryRequest;
  const cacheKey = buildResolveTargetDeviceCacheKey(inventoryRequest, options);
  const selectionContext = {
    simulatorSetPath: iosSimulatorSetPath,
    allowStoppedAndroidAvdPlaceholders: options.allowStoppedAndroidAvdPlaceholders,
  };
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
      const injectedDevices = await readInjectedDeviceInventory(inventoryRequest);
      if (injectedDevices) {
        if (isAppleResolutionSelector(selector)) {
          return cacheResolvedTargetDevice(
            cacheKey,
            await resolveAppleDevice(injectedDevices, selector as AppleDeviceSelector, {
              simulatorSetPath: iosSimulatorSetPath,
              allowLocalSimulatorFallback: inventoryRequest.leaseProvider === undefined,
              appleSimulatorAppTarget: options.appleSimulatorAppTarget,
            }),
          );
        }
        return cacheResolvedTargetDevice(
          cacheKey,
          await resolveDevice(injectedDevices, selector, selectionContext),
        );
      }

      const devices = await listLocalDeviceInventory(inventoryRequest);

      if (isAppleResolutionSelector(selector)) {
        return cacheResolvedTargetDevice(
          cacheKey,
          await resolveAppleDevice(devices, selector as AppleDeviceSelector, {
            simulatorSetPath: iosSimulatorSetPath,
            appleSimulatorAppTarget: options.appleSimulatorAppTarget,
          }),
        );
      }

      return cacheResolvedTargetDevice(
        cacheKey,
        await resolveDevice(devices, selector, selectionContext),
      );
    },
    diagnosticData,
  );
}

export function buildDeviceInventoryRequestFromFlags(
  flags: ResolveDeviceFlags,
): DeviceInventoryRequest {
  const platform = flags.platform;
  if (flags.target && !platform) {
    throw new AppError(
      'INVALID_ARGS',
      'Device target selector requires --platform. Use --platform ios|macos|android|linux|apple with --target mobile|tv|desktop.',
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

export async function withDeviceInventoryProvider<T>(
  provider: DeviceInventoryProvider | undefined,
  task: () => Promise<T>,
): Promise<T> {
  if (!provider) return await task();
  return await deviceInventoryProviderScope.run(provider, task);
}

export async function withTargetDeviceResolutionScope<T>(
  provider: DeviceInventoryProvider | undefined,
  task: () => Promise<T>,
): Promise<T> {
  return await withDeviceInventoryProvider(
    provider,
    async () => await withResolveTargetDeviceCacheScope(task),
  );
}

export async function listDeviceInventory(request: DeviceInventoryRequest): Promise<DeviceInfo[]> {
  return (await readInjectedDeviceInventory(request)) ?? (await listLocalDeviceInventory(request));
}

async function readInjectedDeviceInventory(
  request: DeviceInventoryRequest,
): Promise<DeviceInfo[] | null> {
  const provider = deviceInventoryProviderScope.getStore();
  if (!provider) return null;
  const devices = await provider(request);
  if (devices === undefined || devices === null) return null;
  return devices.map((device) => ({ ...device }));
}

function isAppleResolutionSelector(selector: {
  platform?: PlatformSelector;
  target?: DeviceTarget;
}): boolean {
  return isApplePlatform(selector.platform);
}

function readResolveTargetDeviceCache(cacheKey: string): DeviceInfo | undefined {
  const cache = resolveTargetDeviceCacheScope.getStore();
  const cached = cache?.get(cacheKey);
  if (!cached) return undefined;
  return { ...cached };
}

function cacheResolvedTargetDevice(cacheKey: string, device: DeviceInfo): DeviceInfo {
  resolveTargetDeviceCacheScope.getStore()?.set(cacheKey, { ...device });
  return device;
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
