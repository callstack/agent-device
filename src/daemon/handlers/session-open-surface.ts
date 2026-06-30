import { parseSessionSurface, type SessionSurface } from '../../core/session-surface.ts';
import { resolveFrontmostMacOsApp } from '../../platforms/apple/os/macos/helper.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import type { SessionRuntimeHints, SessionState } from '../types.ts';
import { AppError } from '../../kernel/errors.ts';
import { successText } from '../../utils/success-text.ts';
import type { StartupPerfSample } from './session-startup-metrics.ts';

export function buildOpenResult(params: {
  sessionName: string;
  sessionStateDir: string;
  runnerLogPath: string;
  requestLogPath: string;
  appName?: string;
  appBundleId?: string;
  surface: SessionSurface;
  startup?: StartupPerfSample;
  timing?: Record<string, unknown>;
  device?: DeviceInfo;
  runtime?: SessionRuntimeHints;
  runtimeHintCount: (runtime: SessionRuntimeHints) => number;
}): Record<string, unknown> {
  const {
    sessionName,
    sessionStateDir,
    runnerLogPath,
    requestLogPath,
    appName,
    appBundleId,
    surface,
    startup,
    timing,
    device,
    runtime,
    runtimeHintCount,
  } = params;
  const result: Record<string, unknown> = {
    session: sessionName,
    surface,
    sessionStateDir,
    runnerLogPath,
    requestLogPath,
  };
  if (appName) result.appName = appName;
  if (appBundleId) result.appBundleId = appBundleId;
  if (startup) result.startup = startup;
  if (timing) result.timing = timing;
  if (runtime && runtimeHintCount(runtime) > 0) {
    result.runtime = runtime;
  }
  if (device) {
    result.platform = device.platform;
    result.target = device.target ?? 'mobile';
    result.device = device.name;
    result.id = device.id;
    result.kind = device.kind;
    if (device.platform === 'android') {
      result.serial = device.id;
    }
  }
  if (device?.platform === 'ios') {
    result.device_udid = device.id;
    result.ios_simulator_device_set = device.simulatorSetPath ?? null;
  }
  return {
    ...result,
    ...successText(`Opened: ${appName ?? appBundleId ?? sessionName}`),
  };
}

export function buildNextOpenSession(params: {
  existingSession?: SessionState;
  sessionName: string;
  sessionScope?: SessionState['sessionScope'];
  device: DeviceInfo;
  surface: SessionSurface;
  appBundleId?: string;
  appName?: string;
  saveScript: boolean;
}): SessionState {
  const {
    existingSession,
    sessionName,
    sessionScope,
    device,
    surface,
    appBundleId,
    appName,
    saveScript,
  } = params;
  if (existingSession) {
    return {
      ...existingSession,
      device,
      surface,
      appBundleId,
      appName,
      recordSession: existingSession.recordSession || saveScript,
      snapshot: undefined,
    };
  }
  return {
    name: sessionName,
    sessionScope,
    device,
    createdAt: Date.now(),
    surface,
    appBundleId,
    appName,
    recordSession: saveScript,
    actions: [],
  };
}

const LINUX_SUPPORTED_SURFACES = new Set<SessionSurface>(['app', 'desktop', 'frontmost-app']);

function resolveOpenSurface(
  device: DeviceInfo,
  surfaceFlag: string | undefined,
  openTarget: string | undefined,
): SessionSurface {
  if (device.platform === 'linux') {
    if (!surfaceFlag) return 'app';
    const surface = parseSessionSurface(surfaceFlag);
    if (!LINUX_SUPPORTED_SURFACES.has(surface)) {
      throw new AppError(
        'INVALID_ARGS',
        `Linux supports --surface app, desktop, and frontmost-app (got "${surfaceFlag}")`,
      );
    }
    if (surface !== 'app' && openTarget) {
      throw new AppError('INVALID_ARGS', `open --surface ${surface} does not accept an app target`);
    }
    return surface;
  }
  if (device.platform !== 'macos') {
    if (surfaceFlag) {
      throw new AppError('INVALID_ARGS', 'surface is only supported on macOS and Linux');
    }
    return 'app';
  }
  const surface = surfaceFlag ? parseSessionSurface(surfaceFlag) : 'app';
  if (surface !== 'app' && surface !== 'menubar' && openTarget) {
    throw new AppError('INVALID_ARGS', `open --surface ${surface} does not accept an app target`);
  }
  return surface;
}

export function resolveRequestedOpenSurface(params: {
  device: DeviceInfo;
  surfaceFlag: string | undefined;
  openTarget: string | undefined;
  existingSurface?: SessionSurface;
}): SessionSurface {
  const { device, surfaceFlag, openTarget, existingSurface } = params;
  if ((device.platform === 'macos' || device.platform === 'linux') && !surfaceFlag) {
    return existingSurface ?? 'app';
  }
  return resolveOpenSurface(device, surfaceFlag, openTarget);
}

export async function resolveMacOsSurfaceAppState(
  surface: SessionSurface,
): Promise<{ appBundleId?: string; appName?: string }> {
  if (surface === 'app' || surface === 'desktop' || surface === 'menubar') {
    return {};
  }
  const frontmost = await resolveFrontmostMacOsApp();
  return {
    appBundleId: frontmost.bundleId,
    appName: frontmost.appName,
  };
}
