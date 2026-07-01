import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError } from '../kernel/errors.ts';
import {
  isApplePlatform,
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
import type { CliFlags } from '../cli/parser/cli-flags.ts';
import { listLocalDeviceInventory, type DeviceInventoryRequest } from './platform-inventory.ts';
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

type ResolveTargetDeviceOptions = {
  allowStoppedAndroidAvdPlaceholders?: boolean;
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
  context: { simulatorSetPath?: string },
): Promise<DeviceInfo> {
  const selected = await resolveAppleDeviceCandidate(devices, selector, context);

  if (shouldUseAppleSimulatorFallback(selector, selected)) {
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
  return JSON.stringify({ request, options });
}
