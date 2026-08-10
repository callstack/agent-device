import { isCommandSupportedOnDevice, listCapabilityCommands } from '../../core/capabilities.ts';
import { listDeviceInventory } from '../../core/device-inventory-context.ts';
import { assertResolvedAppsFilter } from '@agent-device/contracts/device';
import { asAppError } from '@agent-device/kernel/errors';
import {
  isApplePlatform,
  isMacOs,
  matchesPlatformSelector,
  publicPlatformString,
  resolveAppleSimulatorSetPathForSelector,
  type DeviceInfo,
  type PlatformSelector,
} from '@agent-device/kernel/device';
import {
  resolveAndroidSerialAllowlist,
  resolveIosSimulatorDeviceSetPath,
} from '../../utils/device-isolation.ts';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import { resolveSessionRunnerLogPath, SessionStore } from '../session-store.ts';
import { listAndroidApps } from '../../platforms/android/app-lifecycle.ts';
import { listIosApps } from '../../platforms/apple/core/apps.ts';
import { listHarmonyApps } from '../../platforms/harmonyos/app-lifecycle.ts';
import { getRequestSignal } from '../../request/cancel.ts';
import { requireSessionOrExplicitSelector, resolveCommandDevice } from './session-device-utils.ts';
import { errorResponse, requireCommandSupported } from './response.ts';
import { resolveImplicitSessionScope, sessionMatchesScope } from '../session-routing.ts';

export async function handleSessionInventoryCommands(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
}): Promise<DaemonResponse | null> {
  const { req, sessionName, sessionStore } = params;
  switch (req.command) {
    case 'session_list':
      return sessionListInventoryResponse(req, sessionStore);
    case 'devices':
      return await devicesInventoryResponse(req);
    case 'capabilities':
      return await capabilitiesInventoryResponse({ req, sessionName, sessionStore });
    case 'apps':
      return await handleAppsInventory({ req, sessionName, sessionStore });
    default:
      return null;
  }
}

function sessionListInventoryResponse(
  req: DaemonRequest,
  sessionStore: SessionStore,
): DaemonResponse {
  const scope = resolveImplicitSessionScope(req);
  return {
    ok: true,
    data: {
      sessions: sessionStore
        .toArray()
        .filter((session) => sessionMatchesScope(session, scope))
        .map((session) => publicSessionInfo(session, sessionStore)),
    },
  };
}

function publicSessionInfo(
  session: ReturnType<SessionStore['toArray']>[number],
  sessionStore: SessionStore,
) {
  const sessionStateDir = sessionStore.resolveSessionDir(session.name);
  return {
    name: session.name,
    sessionStateDir,
    runnerLogPath: resolveSessionRunnerLogPath(sessionStateDir),
    platform: publicPlatformString(session.device),
    ...(isApplePlatform(session.device.platform) && session.device.appleOs
      ? { appleOs: session.device.appleOs }
      : {}),
    target: session.device.target ?? 'mobile',
    surface: session.surface ?? 'app',
    device: session.device.name,
    id: session.device.id,
    device_id: session.device.id,
    createdAt: session.createdAt,
    ...(isApplePlatform(session.device.platform) &&
      !isMacOs(session.device) && {
        device_udid: session.device.id,
        ios_simulator_device_set: session.device.simulatorSetPath ?? null,
      }),
  };
}

async function devicesInventoryResponse(req: DaemonRequest): Promise<DaemonResponse> {
  try {
    return {
      ok: true,
      data: { devices: (await resolveInventoryDevices(req)).map(publicDeviceInfo) },
    };
  } catch (err) {
    const appErr = asAppError(err);
    return errorResponse(appErr.code, appErr.message, appErr.details);
  }
}

async function resolveInventoryDevices(req: DaemonRequest): Promise<DeviceInfo[]> {
  const requestedPlatform = req.flags?.platform;
  const devices = await listDeviceInventory(inventoryDeviceQuery(req, requestedPlatform));
  return filterInventoryDevices(devices, req.flags?.platform, req.flags?.target);
}

function inventoryDeviceQuery(req: DaemonRequest, platform: PlatformSelector | undefined) {
  const flags = req.flags;
  return {
    platform,
    target: flags?.target,
    deviceName: flags?.device,
    udid: flags?.udid,
    serial: flags?.serial,
    iosSimulatorSetPath: inventoryIosSimulatorSetPath(
      flags?.iosSimulatorDeviceSet,
      platform,
      flags?.target,
    ),
    androidSerialAllowlist: inventoryAndroidSerialAllowlist(flags?.androidDeviceAllowlist),
  };
}

function inventoryIosSimulatorSetPath(
  configuredPath: string | undefined,
  platform: PlatformSelector | undefined,
  target: DeviceInfo['target'],
) {
  return resolveAppleSimulatorSetPathForSelector({
    simulatorSetPath: resolveIosSimulatorDeviceSetPath(configuredPath),
    platform,
    target,
  });
}

function inventoryAndroidSerialAllowlist(configuredAllowlist: string | undefined) {
  const allowlist = resolveAndroidSerialAllowlist(configuredAllowlist);
  return allowlist ? Array.from(allowlist).sort() : undefined;
}

function filterInventoryDevices(
  devices: DeviceInfo[],
  platform: PlatformSelector | undefined,
  target: DeviceInfo['target'],
): DeviceInfo[] {
  const platformFiltered = platform
    ? devices.filter((device) => matchesRequestedPlatform(device, platform))
    : devices;
  return target
    ? platformFiltered.filter((device) => (device.target ?? 'mobile') === target)
    : platformFiltered;
}

async function capabilitiesInventoryResponse(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
}): Promise<DaemonResponse> {
  const resolution = await resolveInventoryCommandDevice({
    ...params,
    ensureReady: false,
    allowStoppedAndroidAvdPlaceholders: true,
  });
  if ('response' in resolution) return resolution.response;
  const { device } = resolution;
  return {
    ok: true,
    data: {
      device: publicDeviceInfo(device),
      availableCommands: listCapabilityCommands().filter((command) =>
        isCommandSupportedOnDevice(command, device),
      ),
    },
  };
}

async function handleAppsInventory(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
}): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore } = params;
  const resolution = await resolveInventoryCommandDevice({
    req,
    sessionName,
    sessionStore,
    ensureReady: true,
  });
  if ('response' in resolution) return resolution.response;
  const { device } = resolution;
  const unsupported = requireCommandSupported('apps', device);
  if (unsupported) return unsupported;
  const appsFilter = assertResolvedAppsFilter(req.flags?.appsFilter);
  if (isApplePlatform(device.platform)) {
    const apps = await listIosApps(device, appsFilter);
    return appsInventoryResponse(apps.map((app) => ({ id: app.bundleId, name: app.name })));
  }
  if (device.platform === 'harmonyos') {
    const apps = await listHarmonyApps(device, appsFilter, {
      signal: getRequestSignal(req.meta?.requestId),
    });
    return appsInventoryResponse(apps.map((app) => ({ id: app.package, name: app.name })));
  }
  const apps = await listAndroidApps(device, appsFilter);
  return appsInventoryResponse(apps.map((app) => ({ id: app.package, name: app.name })));
}

function appsInventoryResponse(apps: Array<{ id: string; name: string }>): DaemonResponse {
  return {
    ok: true,
    data: {
      apps: apps.map((app) =>
        app.name && app.name !== app.id ? `${app.name} (${app.id})` : app.id,
      ),
    },
  };
}

async function resolveInventoryCommandDevice(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  ensureReady: boolean;
  allowStoppedAndroidAvdPlaceholders?: boolean;
}): Promise<{ device: DeviceInfo } | { response: DaemonResponse }> {
  const { req, sessionName, sessionStore, ensureReady, allowStoppedAndroidAvdPlaceholders } =
    params;
  const session = sessionStore.get(sessionName);
  const flags = req.flags ?? {};
  const response = requireSessionOrExplicitSelector(req.command, session, flags);
  if (response) return { response };

  return {
    device: await resolveCommandDevice({
      session,
      flags,
      ensureReady,
      allowStoppedAndroidAvdPlaceholders,
    }),
  };
}

function publicDeviceInfo({
  simulatorSetPath: _simulatorSetPath,
  iosPhysicalDeviceBackend: _iosPhysicalDeviceBackend,
  appleOs,
  ...device
}: DeviceInfo): Record<string, unknown> {
  return {
    ...device,
    platform: publicPlatformString({ platform: device.platform, appleOs }),
    ...(isApplePlatform(device.platform) && appleOs ? { appleOs } : {}),
  };
}

function matchesRequestedPlatform(
  device: DeviceInfo,
  requestedPlatform: PlatformSelector | undefined,
): boolean {
  return matchesPlatformSelector(device, requestedPlatform);
}
