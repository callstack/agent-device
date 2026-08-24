import {
  commandRuntimeUseRequirements,
  isCommandSupportedOnDevice,
  listCapabilityCommands,
} from '../../core/capabilities.ts';
import { listDeviceInventory } from '../../request/device-inventory-context.ts';
import { assertResolvedAppsFilter } from '@agent-device/contracts/device';
import { AppError, asAppError } from '@agent-device/kernel/errors';
import {
  isApplePlatform,
  isIosFamily,
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
import {
  requireSessionOrExplicitSelector,
  resolveCommandDevice,
  selectorTargetsSessionDevice,
} from './session-device-utils.ts';
import { errorResponse } from './response.ts';
import { resolveImplicitSessionScope, sessionMatchesScope } from '../session-routing.ts';
import type {
  BoundDeviceRuntime,
  RuntimeFacts,
  RuntimeOperationFact,
} from '@agent-device/contracts/platform-runtime';
import {
  type PlatformRuntimeOperations,
  appsRuntimeUse,
} from '@agent-device/contracts/platform-runtime-operations';
import { ensureAppsRuntimeReady, listAppsFromRuntime } from '../apps-runtime.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';

export async function handleSessionInventoryCommands(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}): Promise<DaemonResponse | null> {
  const { req, sessionName, sessionStore } = params;
  switch (req.command) {
    case 'session_list':
      return sessionListInventoryResponse(req, sessionStore);
    case 'devices':
      return await devicesInventoryResponse(req);
    case 'capabilities':
      return await capabilitiesInventoryResponse({
        req,
        sessionName,
        sessionStore,
        inspectFacts: params.inspectFacts,
      });
    case 'apps':
      return await handleAppsInventory({
        req,
        sessionName,
        sessionStore,
        bindDevice: params.bindDevice,
        inspectFacts: params.inspectFacts,
      });
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
  inspectFacts?: InspectDeviceRuntimeFacts;
}): Promise<DaemonResponse> {
  const resolution = await resolveInventoryCommandDevice({
    ...params,
    ensureReady: false,
    androidAvdSelection: 'include-stopped',
  });
  if ('response' in resolution) return resolution.response;
  const { device } = resolution;
  const sessionOwnedAppStateAvailable = isSessionOwnedAppStateAvailable(
    device,
    params.sessionStore.get(params.sessionName),
    params.req.flags,
  );
  // Capability projection is admission-only: every fact-owned command reads this one
  // side-effect-free exact-device snapshot, never a deleted descriptor capability bucket, and
  // never a binding. R63 retired the three `bindDevice` probes that used to answer
  // `logs`/`network`/`record`: every owner composes a binding's facts with the same function
  // `inspectFacts` calls, so the probes read back values this snapshot already carries while
  // costing a device claim on a read-only query. ADR 0019 §6 requires a `none` descriptor to bind
  // nothing, and `capabilities` is one.
  const facts = await inspectCapabilityFacts(device, params.inspectFacts);
  return {
    ok: true,
    data: {
      device: publicDeviceInfo(device),
      availableCommands: listCapabilityCommands().filter((command) => {
        // A session that already owns an app identity answers appstate itself, so it stays
        // available even when the sessionless runtime probe cannot see a foreground app.
        if (command === 'appstate' && sessionOwnedAppStateAvailable) return true;
        const factOwned = factOwnedCapabilityAvailable(command, facts);
        if (factOwned !== undefined) return factOwned;
        return isCommandSupportedOnDevice(command, device);
      }),
    },
  };
}

function isSessionOwnedAppStateAvailable(
  device: DeviceInfo,
  session: ReturnType<SessionStore['get']>,
  flags: DaemonRequest['flags'],
): boolean {
  if (!session) return false;
  if (!isIosFamily(device) && !isMacOs(device)) return false;
  if (!selectorTargetsSessionDevice(flags, session)) return false;
  return hasSessionAppIdentity(session) || hasMacSessionSurface(device, session);
}

function hasSessionAppIdentity(session: NonNullable<ReturnType<SessionStore['get']>>): boolean {
  return Boolean(session.appName || session.appBundleId);
}

function hasMacSessionSurface(
  device: DeviceInfo,
  session: NonNullable<ReturnType<SessionStore['get']>>,
): boolean {
  return Boolean(
    isMacOs(device) &&
    session.surface !== undefined &&
    session.surface !== 'app' &&
    session.surface !== 'frontmost-app',
  );
}

/**
 * Whether the exact device admits any of `command`'s declared runtime uses, or `undefined` when
 * the command is not fact-owned at all.
 *
 * R63 reads the requirement straight off the descriptor (`commandRuntimeUseRequirements`), so a
 * command cannot be migrated in one place and left projecting from a stale list in another —
 * which is precisely how a real Vega VVD came to advertise `snapshot diff get is wait focus` it
 * cannot run.
 */
function factOwnedCapabilityAvailable(
  command: string,
  facts: RuntimeFacts<PlatformRuntimeOperations> | undefined,
): boolean | undefined {
  const declaredUses = commandRuntimeUseRequirements(command);
  if (!declaredUses) return undefined;
  if (!facts) return false;
  // A request names exactly one action, so one fully admitted use is enough. An empty `required`
  // is not one: `[].every` is vacuously true, and a plan that needs no operation must not read as
  // proof that the device can run the command.
  return declaredUses.some(
    (required) =>
      required.length > 0 && required.every((operation) => hasAvailableFact(facts, operation)),
  );
}

/**
 * Descriptor execution metadata is structurally validated as string arrays, not as keys of the
 * concrete facts catalog. Keep the projection fail-closed when a descriptor names an operation the
 * inspected owner does not state, instead of letting an arbitrary property lookup throw out of the
 * whole `capabilities` response.
 */
function hasAvailableFact(
  facts: RuntimeFacts<PlatformRuntimeOperations>,
  operation: string,
): boolean {
  if (!Object.hasOwn(facts.operations, operation)) return false;
  return (
    (facts.operations as Readonly<Record<string, RuntimeOperationFact>>)[operation]?.available ===
    true
  );
}

async function handleAppsInventory(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  bindDevice?: BindDeviceRuntime;
  inspectFacts?: InspectDeviceRuntimeFacts;
}): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore, bindDevice, inspectFacts } = params;
  const resolution = await resolveInventoryCommandDevice({
    req,
    sessionName,
    sessionStore,
    ensureReady: false,
    androidAvdSelection: 'include-stopped',
  });
  if ('response' in resolution) return resolution.response;
  const { device } = resolution;
  const appsFilter = assertResolvedAppsFilter(req.flags?.appsFilter);

  const resolvedAndroidSerialAllowlist = resolveAndroidSerialAllowlist(
    req.flags?.androidDeviceAllowlist,
  );
  const runtimeResolution = await resolveAppsRuntime({ device, inspectFacts, bindDevice });
  if ('response' in runtimeResolution) return runtimeResolution.response;
  const runtime = runtimeResolution.runtime;
  const readyDevice = await ensureAppsRuntimeReady(runtime, {
    serial: req.flags?.serial,
    androidSerialAllowlist: resolvedAndroidSerialAllowlist
      ? [...resolvedAndroidSerialAllowlist].sort()
      : undefined,
  });
  const apps = await listAppsFromRuntime(runtime, readyDevice, appsFilter);
  return appsInventoryResponse(apps);
}

async function inspectCapabilityFacts(
  device: DeviceInfo,
  inspectFacts: InspectDeviceRuntimeFacts | undefined,
): Promise<RuntimeFacts<PlatformRuntimeOperations> | undefined> {
  if (!inspectFacts) return undefined;
  try {
    return await inspectFacts(device);
  } catch {
    // Capability projection is advisory. A provider facts failure must fail closed rather than
    // reconstructing support from the retired capability matrix.
    return undefined;
  }
}

async function resolveAppsRuntime(params: {
  device: DeviceInfo;
  inspectFacts: InspectDeviceRuntimeFacts | undefined;
  bindDevice: BindDeviceRuntime | undefined;
}): Promise<{ response: DaemonResponse } | { runtime: BoundDeviceRuntime<typeof appsRuntimeUse> }> {
  if (!params.inspectFacts) {
    throw new AppError('COMMAND_FAILED', 'Device runtime facts inspection is unavailable.', {
      reason: 'runtime-gateway-missing',
    });
  }
  const facts = await params.inspectFacts(params.device);
  const unavailable = [facts.operations.ensureReady, facts.operations.listApps].find(
    (fact) => !fact.available,
  );
  if (unavailable && !unavailable.available) {
    return {
      response: errorResponse(
        'UNSUPPORTED_OPERATION',
        'apps is not supported on this device',
        undefined,
        unavailable.hint ? { hint: unavailable.hint } : undefined,
      ),
    };
  }
  if (!params.bindDevice) {
    throw new AppError('COMMAND_FAILED', 'Device runtime binding is unavailable.', {
      reason: 'runtime-gateway-missing',
    });
  }
  return { runtime: await params.bindDevice(params.device, appsRuntimeUse) };
}

function appsInventoryResponse(apps: readonly { id: string; name: string }[]): DaemonResponse {
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
  androidAvdSelection?: 'running-only' | 'include-stopped';
}): Promise<{ device: DeviceInfo } | { response: DaemonResponse }> {
  const { req, sessionName, sessionStore, ensureReady, androidAvdSelection } = params;
  const session = sessionStore.get(sessionName);
  const flags = req.flags ?? {};
  const response = requireSessionOrExplicitSelector(req.command, session, flags);
  if (response) return { response };

  return {
    device: await resolveCommandDevice({
      session,
      flags,
      ensureReady,
      androidAvdSelection,
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
