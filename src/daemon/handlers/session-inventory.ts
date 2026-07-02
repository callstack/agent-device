import { listDeviceInventory } from '../../core/dispatch-resolve.ts';
import { assertResolvedAppsFilter } from '../../contracts/app-inventory.ts';
import { asAppError } from '../../kernel/errors.ts';
import {
  isApplePlatform,
  isMacOs,
  matchesPlatformSelector,
  publicPlatformString,
  resolveAppleSimulatorSetPathForSelector,
  type DeviceInfo,
  type PlatformSelector,
} from '../../kernel/device.ts';
import {
  resolveAndroidSerialAllowlist,
  resolveIosSimulatorDeviceSetPath,
} from '../../utils/device-isolation.ts';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import { resolveSessionRunnerLogPath, SessionStore } from '../session-store.ts';
import { listAndroidApps } from '../../platforms/android/app-lifecycle.ts';
import { listIosApps } from '../../platforms/apple/core/apps.ts';
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
              // approach (b): emit the PUBLIC leaf platform (ios/macos), not `apple`.
              platform: publicPlatformString(session.device),
              // Additive Apple-OS discriminant; Apple devices only. Gate on the
              // platform (not just field presence) so a non-Apple record carrying a
              // stray appleOs value never surfaces it.
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
      // Surface the `appleOs` discriminant additively so consumers can distinguish
      // iPhone/iPad/tvOS/visionOS/macOS instead of only the leaf `ios`/`macos`. It is
      // emitted ONLY for Apple devices (non-Apple platforms carry no `appleOs`), and
      // `platform` stays the PUBLIC leaf via `publicPlatformString` (approach b). The
      // internal-only `simulatorSetPath` is still stripped. `appleOs` values never equal
      // the internal `apple` token, so this does not affect the apple-leak guard.
      const publicDevices = filtered.map(
        ({ simulatorSetPath: _simulatorSetPath, appleOs, ...device }) => ({
          ...device,
          platform: publicPlatformString({ platform: device.platform, appleOs }),
          ...(isApplePlatform(device.platform) && appleOs ? { appleOs } : {}),
        }),
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
  return matchesPlatformSelector(device, requestedPlatform);
}
