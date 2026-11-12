import type { CliFlags } from '@agent-device/contracts/command';
import type { DeviceInventoryRequest } from '@agent-device/contracts/device';
import {
  hasExplicitDeviceIdentitySelector,
  isApplePlatform,
  resolveRequestAppleSimulatorSetPath,
  webSessionDevice,
  type DeviceInfo,
  type DeviceTarget,
  type WebSessionIdentity,
} from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { EnvMap } from '@agent-device/kernel/source-value';
import { AsyncLocalStorage } from 'node:async_hooks';
import { resolveAndroidSerialAllowlist } from '@agent-device/kernel/device-isolation';
import { withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';
import {
  listLocalDeviceInventory,
  readAppDeviceResolver,
  readDeviceInventory,
  shouldPropagateDeviceInventoryProbeError,
} from './device-inventory-context.ts';
import type {
  BootSelectionIntent,
  DeviceSelectionResult,
  InventoryDeviceSelectionParams,
} from './device-selection-resolver.ts';

/** Lazy owner seam: keeps the resolver out of the dispatch eager closure. */
async function resolveInventorySelection(
  params: InventoryDeviceSelectionParams,
): Promise<DeviceSelectionResult> {
  const { resolveInventoryDeviceSelection } = await import('./device-selection-resolver.ts');
  return await resolveInventoryDeviceSelection(params);
}
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
  /** The caller's host environment; allowlists and simulator sets resolve from it. */
  env: EnvMap;
  androidAvdSelection?: 'running-only' | 'include-stopped';
  appleSimulatorAppTarget?: string;
  /**
   * The app an `open` names on the app surface. On a host that holds apps as devices of their own
   * (ADR 0035), the selection is that app's device instead of the host.
   */
  appDeviceTarget?: string;
  /**
   * The web session the request runs in. A local web selection is then that session's device, so
   * a web session holds, locks, and claims its own browser, and the host stays an inventory entry.
   */
  webSession?: WebSessionIdentity;
  /** Only `boot` sets this; every other command keeps refusing a tie. */
  boot?: BootSelectionIntent;
};

function canFallbackAfterAppleDeviceNotFound(
  error: unknown,
  selector: AppleDeviceSelector,
): boolean {
  return (
    !hasExplicitDeviceIdentitySelector(selector) &&
    error instanceof AppError &&
    error.code === 'DEVICE_NOT_FOUND'
  );
}

function shouldUseAppleSimulatorFallback(
  selector: AppleDeviceSelector,
  selected: DeviceInfo | undefined,
): boolean {
  return (
    !hasExplicitDeviceIdentitySelector(selector) &&
    (!selector.platform || selector.platform === 'apple' || selector.platform === 'ios') &&
    selector.target !== 'desktop' &&
    (!selected || selected.kind === 'device')
  );
}

export async function resolveTargetDevice(
  flags: ResolveDeviceFlags,
  options: ResolveTargetDeviceOptions,
): Promise<DeviceInfo> {
  return (await resolveTargetDeviceSelection(flags, options)).device;
}

export async function resolveTargetDeviceSelection(
  flags: ResolveDeviceFlags,
  options: ResolveTargetDeviceOptions,
): Promise<DeviceSelectionResult> {
  const inventoryRequest = {
    ...buildDeviceInventoryRequestFromFlags(flags, options.env),
    androidAvdSelection: options.androidAvdSelection ?? 'running-only',
  };
  const { iosSimulatorSetPath, ...selector } = inventoryRequest;
  const cacheKey = buildResolveTargetDeviceCacheKey(inventoryRequest, options);
  const diagnosticData = {
    platform: inventoryRequest.platform,
    target: flags.target,
    // The selector the resolution was asked for, echoed for recovery lanes whose whole job is
    // re-resolving one stated device: which udid was requested and which simulator set was
    // scoped must be visible in the request log without debug-only dumps.
    ...(inventoryRequest.udid ? { udid: inventoryRequest.udid } : {}),
    ...(iosSimulatorSetPath ? { iosSimulatorSetPath } : {}),
    cacheHit: false,
  };
  return await withDiagnosticTimer(
    'resolve_target_device',
    async () => {
      const cached = readResolveTargetDeviceCache(cacheKey);
      if (cached) {
        diagnosticData.cacheHit = true;
        return await selectScopedDevice(cached, options);
      }
      const inventory = await readDeviceInventory(inventoryRequest);
      const devices = [...inventory.devices];

      if (isApplePlatform(selector.platform) && inventory.source === 'local') {
        const selection = await resolveLocalAppleDeviceSelection(
          devices,
          selector as AppleDeviceSelector,
          {
            simulatorSetPath: iosSimulatorSetPath,
            appleSimulatorAppTarget: options.appleSimulatorAppTarget,
            boot: options.boot,
          },
        );
        return await selectScopedDevice(cacheResolvedTargetDevice(cacheKey, selection), options);
      }

      const selection = await resolveInventorySelection({
        devices,
        selector,
        source: inventory.source,
        boot: options.boot,
      });
      return await selectScopedDevice(cacheResolvedTargetDevice(cacheKey, selection), options);
    },
    diagnosticData,
  );
}

/**
 * The app device or web session device the options name on the selected host. The request cache
 * keeps the host, so each open in one request (a batch or a replay) derives the device it names.
 */
async function selectScopedDevice(
  selection: DeviceSelectionResult,
  options: Pick<ResolveTargetDeviceOptions, 'appDeviceTarget' | 'webSession'>,
): Promise<DeviceSelectionResult> {
  if (
    options.webSession !== undefined &&
    selection.source === 'local' &&
    selection.device.platform === 'web'
  ) {
    return { ...selection, device: webSessionDevice(selection.device, options.webSession) };
  }
  const appTarget = options.appDeviceTarget;
  const resolveAppDevice = appTarget ? readAppDeviceResolver() : undefined;
  if (!appTarget || !resolveAppDevice || selection.source !== 'local') return selection;
  const device = await resolveAppDevice(selection.device, appTarget);
  return device ? { ...selection, device } : selection;
}

async function resolveLocalAppleDeviceSelection(
  devices: DeviceInfo[],
  selector: AppleDeviceSelector,
  context: {
    simulatorSetPath?: string;
    appleSimulatorAppTarget?: string;
    boot?: BootSelectionIntent;
  },
): Promise<DeviceSelectionResult> {
  let selection: DeviceSelectionResult | undefined;
  try {
    selection = await resolveInventorySelection({
      devices,
      selector,
      source: 'local',
      appleSimulatorAppTarget: context.appleSimulatorAppTarget,
      boot: context.boot,
    });
  } catch (error) {
    if (!canFallbackAfterAppleDeviceNotFound(error, selector)) throw error;
  }

  const simulatorFallback = await resolveAppleSimulatorFallback(
    selector,
    context,
    selection?.device,
  );
  if (simulatorFallback) return simulatorFallback;
  if (selection) return selection;
  throw new AppError('DEVICE_NOT_FOUND', 'No devices found', { selector });
}

async function resolveAppleSimulatorFallback(
  selector: AppleDeviceSelector,
  context: { simulatorSetPath?: string; boot?: BootSelectionIntent },
  selected: DeviceInfo | undefined,
): Promise<DeviceSelectionResult | undefined> {
  if (!shouldUseAppleSimulatorFallback(selector, selected)) return undefined;
  try {
    const localDevices = await listLocalDeviceInventory({
      platform: selector.platform ?? 'ios',
      target: selector.target,
      iosSimulatorSetPath: context.simulatorSetPath,
      kind: 'simulator',
    });
    return await resolveInventorySelection({
      devices: localDevices,
      selector,
      source: 'local',
      boot: context.boot,
    });
  } catch (error) {
    if (shouldPropagateDeviceInventoryProbeError(error)) throw error;
    return undefined;
  }
}

export function buildDeviceInventoryRequestFromFlags(
  flags: ResolveDeviceFlags,
  env: EnvMap,
): DeviceInventoryRequest {
  const platform = flags.platform;
  if (flags.target && !platform) {
    throw new AppError(
      'INVALID_ARGS',
      'Device target selector requires --platform. Use --platform ios|macos|android|vega|linux|apple with --target mobile|tv|desktop.',
    );
  }
  const iosSimulatorSetPath = resolveRequestAppleSimulatorSetPath({
    requestedSetPath: flags.iosSimulatorDeviceSet,
    platform,
    target: flags.target,
    env,
  });
  const androidSerialAllowlist = resolveAndroidSerialAllowlist(flags.androidDeviceAllowlist, env);
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
  // when dispatch has no app target to pass back through this seam. The request
  // already holds what selection reads from env, and Android SDK discovery adds
  // to that env during the first inventory read.
  const {
    env: _env,
    appleSimulatorAppTarget: _appleSimulatorAppTarget,
    appDeviceTarget: _appDeviceTarget,
    webSession: _webSession,
    ...cacheOptions
  } = options;
  return JSON.stringify({ request, options: cacheOptions });
}
