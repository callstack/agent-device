import { isDeepLinkTarget } from '../../contracts/open-target.ts';
import { ensureDeviceReady } from '../device-ready.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import type { DaemonRequest, DaemonResponse, SessionRuntimeHints, SessionState } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import {
  classifyAndroidAppTarget,
  formatAndroidInstalledPackageRequiredMessage,
} from '../../platforms/android/open-target.ts';
import {
  maybeClearRemovedRuntimeTransportHints,
  tryResolveOpenRuntimeHints,
} from './session-runtime.ts';
import {
  resolveAndroidPackageForOpen,
  resolveSessionAppBundleIdForTarget,
} from './session-open-target.ts';
import { AppError } from '../../kernel/errors.ts';
import { errorResponse } from './response.ts';
import {
  resolveMacOsSurfaceAppState,
  resolveRequestedOpenSurface,
} from './session-open-surface.ts';
import type { SessionSurface } from '../../contracts/session-surface.ts';

type OpenCommandDetails = {
  appBundleId?: string;
  appName?: string;
  runtime: SessionRuntimeHints | undefined;
};

export type PreparedOpenCommandDetailsResult =
  | { type: 'response'; response: DaemonResponse }
  | { type: 'details'; details: OpenCommandDetails };

export function invalidOpenArgs(message: string): DaemonResponse {
  return errorResponse('INVALID_ARGS', message);
}

export function resolveOpenSurfaceResponse(
  device: DeviceInfo,
  surfaceFlag: string | undefined,
  openTarget: string | undefined,
  existingSurface?: SessionSurface,
): SessionSurface | DaemonResponse {
  try {
    return resolveRequestedOpenSurface({
      device,
      surfaceFlag,
      openTarget,
      existingSurface,
    });
  } catch (error) {
    return errorResponse(
      error instanceof AppError ? error.code : 'INVALID_ARGS',
      String((error as Error).message),
    );
  }
}

export function validateResolvedOpenRequest(params: {
  shouldRelaunch: boolean;
  openTarget: string | undefined;
  surface: SessionSurface;
  device: DeviceInfo;
}): DaemonResponse | null {
  const { shouldRelaunch, openTarget, surface, device } = params;
  if (!shouldRelaunch) return null;
  if (openTarget && isDeepLinkTarget(openTarget)) {
    return invalidOpenArgs('open --relaunch does not support URL targets.');
  }
  if (surface !== 'app') {
    return invalidOpenArgs('open --relaunch is supported only for app surfaces.');
  }
  if (
    device.platform === 'android' &&
    openTarget &&
    classifyAndroidAppTarget(openTarget) === 'binary'
  ) {
    return invalidOpenArgs(formatAndroidInstalledPackageRequiredMessage(openTarget));
  }
  return null;
}

export function validatePreResolvedOpenRequest(params: {
  shouldRelaunch: boolean;
  openTarget: string | undefined;
  platform: DeviceInfo['platform'] | undefined;
}): DaemonResponse | null {
  const { shouldRelaunch, openTarget, platform } = params;
  if (!shouldRelaunch) return null;
  if (openTarget && isDeepLinkTarget(openTarget)) {
    return invalidOpenArgs('open --relaunch does not support URL targets.');
  }
  if (platform === 'android' && openTarget && classifyAndroidAppTarget(openTarget) === 'binary') {
    return invalidOpenArgs(formatAndroidInstalledPackageRequiredMessage(openTarget));
  }
  return null;
}

export type IosSimulatorColdBootStartHandler = (device: DeviceInfo) => void;

export async function prepareOpenCommandDetails(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  device: DeviceInfo;
  surface: SessionSurface;
  openTarget: string | undefined;
  existingSession?: SessionState;
  onIosSimulatorColdBootStart?: IosSimulatorColdBootStartHandler;
}): Promise<PreparedOpenCommandDetailsResult> {
  const {
    req,
    sessionName,
    sessionStore,
    device,
    surface,
    openTarget,
    existingSession,
    onIosSimulatorColdBootStart,
  } = params;
  await ensureDeviceReady(device, {
    deviceHub: req.flags?.deviceHub === true,
    onIosSimulatorColdBootStart,
  });
  const { appBundleId, appName } = await resolvePreparedOpenIdentity({
    device,
    surface,
    openTarget,
    existingAppBundleId: existingSession?.appBundleId,
  });
  const runtimeResult = tryResolveOpenRuntimeHints({
    req,
    sessionStore,
    sessionName,
    device,
  });
  if (!runtimeResult.ok) {
    return {
      type: 'response',
      response: runtimeResult,
    };
  }

  if (existingSession) {
    const { runtime, previousRuntime, replacedStoredRuntime } = runtimeResult.data;
    await maybeClearRemovedRuntimeTransportHints({
      replacedStoredRuntime,
      previousRuntime,
      runtime,
      session: existingSession,
    });
  }

  return {
    type: 'details',
    details: {
      appBundleId,
      appName,
      runtime: runtimeResult.data.runtime,
    },
  };
}

async function resolvePreparedOpenIdentity(params: {
  device: DeviceInfo;
  surface: SessionSurface;
  openTarget: string | undefined;
  existingAppBundleId?: string;
}): Promise<{ appBundleId?: string; appName?: string }> {
  const { device, surface, openTarget, existingAppBundleId } = params;
  const macOsSurfaceState = await resolveMacOsSurfaceAppState(surface);
  return {
    appBundleId:
      macOsSurfaceState.appBundleId ??
      (await resolveSessionAppBundleIdForTarget(
        device,
        openTarget,
        existingAppBundleId,
        resolveAndroidPackageForOpen,
      )),
    appName: macOsSurfaceState.appName ?? openTarget,
  };
}
