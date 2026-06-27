import { listDeviceInventory } from '../../core/dispatch-resolve.ts';
import { assertResolvedAppsFilter } from '../../contracts/app-inventory.ts';
import { asAppError } from '../../utils/errors.ts';
import {
  isApplePlatform,
  resolveAppleSimulatorSetPathForSelector,
  type DeviceInfo,
  type PlatformSelector,
} from '../../utils/device.ts';
import {
  resolveAndroidSerialAllowlist,
  resolveIosSimulatorDeviceSetPath,
} from '../../utils/device-isolation.ts';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import { resolveSessionRunnerLogPath, SessionStore } from '../session-store.ts';
import { listAndroidApps } from '../../platforms/android/app-lifecycle.ts';
import { listIosApps } from '../../platforms/ios/apps.ts';
import { requireSessionOrExplicitSelector, resolveCommandDevice } from './session-device-utils.ts';
import { errorResponse, requireCommandSupported } from './response.ts';
import { resolveImplicitSessionScope, sessionMatchesScope } from '../session-routing.ts';

export async function handleSessionInventoryCommands(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
}): Promise<DaemonResponse | null> {
  const { req, sessionName, sessionStore } = params;

  if (req.command === 'session_list') {
    const scope = resolveImplicitSessionScope(req);
    return {
      ok: true,
      data: {
        sessions: sessionStore
          .toArray()
          .filter((session) => sessionMatchesScope(session, scope))
          .map((session) => {
            const sessionStateDir = sessionStore.resolveSessionDir(session.name);
            return {
              name: session.name,
              sessionStateDir,
              runnerLogPath: resolveSessionRunnerLogPath(sessionStateDir),
              platform: session.device.platform,
              target: session.device.target ?? 'mobile',
              surface: session.surface ?? 'app',
              device: session.device.name,
              id: session.device.id,
              device_id: session.device.id,
              createdAt: session.createdAt,
              ...(session.device.platform === 'ios' && {
                device_udid: session.device.id,
                ios_simulator_device_set: session.device.simulatorSetPath ?? null,
              }),
            };
          }),
      },
    };
  }

  if (req.command === 'devices') {
    try {
      const androidSerialAllowlist = resolveAndroidSerialAllowlist(
        req.flags?.androidDeviceAllowlist,
      );
      const requestedPlatform = req.flags?.platform;
      const iosSimulatorSetPath = resolveAppleSimulatorSetPathForSelector({
        simulatorSetPath: resolveIosSimulatorDeviceSetPath(req.flags?.iosSimulatorDeviceSet),
        platform: requestedPlatform,
        target: req.flags?.target,
      });

      const devices = await listDeviceInventory({
        platform: requestedPlatform,
        target: req.flags?.target,
        deviceName: req.flags?.device,
        udid: req.flags?.udid,
        serial: req.flags?.serial,
        iosSimulatorSetPath,
        androidSerialAllowlist: androidSerialAllowlist
          ? Array.from(androidSerialAllowlist).sort()
          : undefined,
      });

      const platformFiltered = requestedPlatform
        ? devices.filter((device) => matchesRequestedPlatform(device, requestedPlatform))
        : devices;
      const filtered = req.flags?.target
        ? platformFiltered.filter((device) => (device.target ?? 'mobile') === req.flags?.target)
        : platformFiltered;
      // Keep appleOs internal-only for now: it is discovery groundwork and the
      // public `devices` shape is not yet meant to expose it. Surfacing it (so
      // agents can tell iPad from iPhone) should be a deliberate later change.
      const publicDevices = filtered.map(
        ({ simulatorSetPath: _simulatorSetPath, appleOs: _appleOs, ...device }) => device,
      );
      return { ok: true, data: { devices: publicDevices } };
    } catch (err) {
      const appErr = asAppError(err);
      return errorResponse(appErr.code, appErr.message, appErr.details);
    }
  }

  if (req.command === 'apps') {
    const session = sessionStore.get(sessionName);
    const flags = req.flags ?? {};
    const guard = requireSessionOrExplicitSelector(req.command, session, flags);
    if (guard) return guard;

    const device = await resolveCommandDevice({
      session,
      flags,
      ensureReady: true,
    });
    const unsupported = requireCommandSupported('apps', device);
    if (unsupported) return unsupported;

    const appsFilter = assertResolvedAppsFilter(req.flags?.appsFilter);
    if (isApplePlatform(device.platform)) {
      const apps = await listIosApps(device, appsFilter);
      return {
        ok: true,
        data: {
          apps: apps.map((app) =>
            app.name && app.name !== app.bundleId ? `${app.name} (${app.bundleId})` : app.bundleId,
          ),
        },
      };
    }

    const apps = await listAndroidApps(device, appsFilter);
    return {
      ok: true,
      data: {
        apps: apps.map((app) =>
          app.name && app.name !== app.package ? `${app.name} (${app.package})` : app.package,
        ),
      },
    };
  }

  return null;
}

function matchesRequestedPlatform(
  device: DeviceInfo,
  requestedPlatform: PlatformSelector | undefined,
): boolean {
  if (!requestedPlatform) return true;
  if (requestedPlatform === 'apple') return isApplePlatform(device.platform);
  return device.platform === requestedPlatform;
}
