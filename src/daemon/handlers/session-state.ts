import { isCommandSupportedOnDevice } from '../../core/capabilities.ts';
import { asAppError } from '../../utils/errors.ts';
import { isApplePlatform, type DeviceInfo } from '../../utils/device.ts';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { ensureDeviceReady } from '../device-ready.ts';
import { shutdownDeviceTarget } from '../target-shutdown.ts';
import {
  hasExplicitSessionFlag,
  requireSessionOrExplicitSelector,
  resolveAndroidEmulatorAvdName,
  resolveCommandDevice,
  selectorTargetsSessionDevice,
} from './session-device-utils.ts';
import { errorResponse } from './response.ts';

async function ensureAndroidEmulatorBoot(params: {
  avdName: string;
  serial?: string;
  headless?: boolean;
}): Promise<DeviceInfo> {
  const { ensureAndroidEmulatorBooted } = await import('../../platforms/android/devices.ts');
  return await ensureAndroidEmulatorBooted(params);
}

const IOS_APPSTATE_SESSION_REQUIRED_MESSAGE =
  'iOS appstate requires an active session on the target device. Run open first (for example: open --session sim --platform ios --device "<name>" <app>).';
const MACOS_APPSTATE_SESSION_REQUIRED_MESSAGE =
  'macOS appstate requires an active session on the target device. Run open first (for example: open --session macos --platform macos "System Settings").';

async function handleAppStateCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
}): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore } = params;
  const session = sessionStore.get(sessionName);
  const flags = req.flags ?? {};
  const normalizedPlatform = flags.platform;

  if (!session && hasExplicitSessionFlag(flags)) {
    const message =
      normalizedPlatform === 'ios'
        ? `No active session "${sessionName}". Run open with --session ${sessionName} first.`
        : `No active session "${sessionName}". Run open with --session ${sessionName} first, or omit --session to query by device selector.`;
    return errorResponse('SESSION_NOT_FOUND', message);
  }

  const guard = requireSessionOrExplicitSelector('appstate', session, flags);
  if (guard) return guard;

  const shouldUseSessionStateForApple =
    isApplePlatform(session?.device.platform) && selectorTargetsSessionDevice(flags, session);
  const targetsIos = normalizedPlatform === 'ios';
  const targetsMacOs = normalizedPlatform === 'macos';

  if (targetsIos && !shouldUseSessionStateForApple) {
    return errorResponse('SESSION_NOT_FOUND', IOS_APPSTATE_SESSION_REQUIRED_MESSAGE);
  }
  if (targetsMacOs && !shouldUseSessionStateForApple) {
    return errorResponse('SESSION_NOT_FOUND', MACOS_APPSTATE_SESSION_REQUIRED_MESSAGE);
  }

  if (shouldUseSessionStateForApple && session) {
    const appName = session.appName ?? session.appBundleId;
    if (!session.appName && !session.appBundleId) {
      if (
        session.device.platform === 'macos' &&
        session.surface &&
        session.surface !== 'app' &&
        session.surface !== 'frontmost-app'
      ) {
        return {
          ok: true,
          data: {
            platform: session.device.platform,
            appName: session.surface,
            appBundleId: session.appBundleId,
            source: 'session',
            surface: session.surface,
          },
        };
      }

      const sessionPlatform = session.device.platform === 'macos' ? 'macOS' : 'iOS';
      return errorResponse(
        'COMMAND_FAILED',
        `No foreground app is tracked for this ${sessionPlatform} session. Open an app in the session, then retry appstate.`,
      );
    }

    return {
      ok: true,
      data: {
        platform: session.device.platform,
        appName: appName ?? 'unknown',
        appBundleId: session.appBundleId,
        source: 'session',
        surface: session.surface ?? 'app',
        ...(session.device.platform === 'ios'
          ? {
              device_udid: session.device.id,
              ios_simulator_device_set: session.device.simulatorSetPath ?? null,
            }
          : {}),
      },
    };
  }

  const device = await resolveCommandDevice({
    session,
    flags,
    ensureReady: true,
  });
  if (device.platform === 'ios') {
    return errorResponse('SESSION_NOT_FOUND', IOS_APPSTATE_SESSION_REQUIRED_MESSAGE);
  }
  if (device.platform === 'macos') {
    return errorResponse('SESSION_NOT_FOUND', MACOS_APPSTATE_SESSION_REQUIRED_MESSAGE);
  }
  if (device.platform === 'web') {
    return errorResponse('UNSUPPORTED_OPERATION', 'appstate is not supported on web.');
  }

  const { getAndroidAppState } = await import('../../platforms/android/app-lifecycle.ts');
  const state = await getAndroidAppState(device);
  return {
    ok: true,
    data: {
      platform: 'android',
      package: state.package,
      activity: state.activity,
    },
  };
}

export async function handleSessionStateCommands(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
}): Promise<DaemonResponse | null> {
  const { req, sessionName, sessionStore } = params;

  if (req.command === 'boot') {
    const session = sessionStore.get(sessionName);
    const flags = req.flags ?? {};
    const guard = requireSessionOrExplicitSelector(req.command, session, flags);
    if (guard) return guard;

    const normalizedPlatform = flags.platform ?? session?.device.platform;
    const targetsAndroid = normalizedPlatform === 'android';
    const wantsAndroidHeadless = flags.headless === true;
    if (wantsAndroidHeadless && !targetsAndroid) {
      return errorResponse(
        'INVALID_ARGS',
        'boot --headless is supported only for Android emulators.',
      );
    }

    const fallbackAvdName = resolveAndroidEmulatorAvdName({
      flags,
      sessionDevice: session?.device,
    });
    const canFallbackLaunchAndroidEmulator = targetsAndroid && Boolean(fallbackAvdName);

    let device: DeviceInfo;
    let launchedAndroidEmulator = false;
    try {
      device = await resolveCommandDevice({
        session,
        flags,
        ensureReady: false,
      });
    } catch (error) {
      const appErr = asAppError(error);
      if (
        targetsAndroid &&
        wantsAndroidHeadless &&
        !fallbackAvdName &&
        appErr.code === 'DEVICE_NOT_FOUND'
      ) {
        return errorResponse(
          'INVALID_ARGS',
          'boot --headless requires --device <avd-name> (or an Android emulator session target).',
        );
      }
      if (
        !canFallbackLaunchAndroidEmulator ||
        appErr.code !== 'DEVICE_NOT_FOUND' ||
        !fallbackAvdName
      ) {
        throw error;
      }
      device = await ensureAndroidEmulatorBoot({
        avdName: fallbackAvdName,
        serial: flags.serial,
        headless: wantsAndroidHeadless,
      });
      launchedAndroidEmulator = true;
    }

    if (flags.target && (device.target ?? 'mobile') !== flags.target) {
      return errorResponse(
        'DEVICE_NOT_FOUND',
        `No ${device.platform} device found matching --target ${flags.target}.`,
      );
    }

    if (targetsAndroid && wantsAndroidHeadless) {
      if (device.platform !== 'android' || device.kind !== 'emulator') {
        return errorResponse(
          'INVALID_ARGS',
          'boot --headless is supported only for Android emulators.',
        );
      }
      if (!launchedAndroidEmulator) {
        const avdName = resolveAndroidEmulatorAvdName({
          flags,
          sessionDevice: session?.device,
          resolvedDevice: device,
        });
        if (!avdName) {
          return errorResponse(
            'INVALID_ARGS',
            'boot --headless requires --device <avd-name> (or an Android emulator session target).',
          );
        }
        device = await ensureAndroidEmulatorBoot({
          avdName,
          serial: flags.serial,
          headless: true,
        });
      }
      await ensureDeviceReady(device);
    } else {
      const shouldEnsureReady = device.platform !== 'android' || device.booted !== true;
      if (shouldEnsureReady) {
        await ensureDeviceReady(device);
      }
    }

    if (!isCommandSupportedOnDevice('boot', device)) {
      return errorResponse('UNSUPPORTED_OPERATION', 'boot is not supported on this device');
    }

    return {
      ok: true,
      data: {
        platform: device.platform,
        target: device.target ?? 'mobile',
        device: device.name,
        id: device.id,
        kind: device.kind,
        booted: true,
      },
    };
  }

  if (req.command === 'shutdown') {
    const activeSession = sessionStore.get(sessionName);
    const flags = req.flags ?? {};
    const guard = requireSessionOrExplicitSelector(req.command, activeSession, flags);
    if (guard) return guard;

    const device = await resolveCommandDevice({
      ensureReady: false,
      flags,
      session: activeSession,
    });
    if (!isCommandSupportedOnDevice('shutdown', device)) {
      return errorResponse(
        'UNSUPPORTED_OPERATION',
        'shutdown is supported only for Apple simulators and Android emulators.',
      );
    }

    if (
      activeSession &&
      activeSession.device.platform === device.platform &&
      activeSession.device.id === device.id
    ) {
      return errorResponse(
        'DEVICE_IN_USE',
        'Cannot shut down an active session device directly. Use close --shutdown to end the session and turn off the simulator/emulator.',
        {
          hint: `Run agent-device close --shutdown --session ${sessionName}`,
          session: sessionName,
          platform: device.platform,
          target: device.target ?? 'mobile',
          device: device.name,
          id: device.id,
          kind: device.kind,
        },
      );
    }

    const shutdown = await shutdownDeviceTarget(device);
    if (!shutdown.success) {
      return errorResponse(
        shutdown.error?.code ?? 'COMMAND_FAILED',
        shutdownFailureMessage(shutdown),
        {
          platform: device.platform,
          target: device.target ?? 'mobile',
          device: device.name,
          id: device.id,
          kind: device.kind,
          shutdown,
        },
      );
    }

    return {
      ok: true,
      data: {
        platform: device.platform,
        target: device.target ?? 'mobile',
        device: device.name,
        id: device.id,
        kind: device.kind,
        shutdown,
      },
    };
  }

  if (req.command === 'appstate') {
    return await handleAppStateCommand({
      req,
      sessionName,
      sessionStore,
    });
  }

  return null;
}

function shutdownFailureMessage(
  shutdown: Awaited<ReturnType<typeof shutdownDeviceTarget>>,
): string {
  const message = shutdown.error?.message ?? shutdown.stderr.trim();
  return message.length > 0 ? message : 'Shutdown failed';
}
