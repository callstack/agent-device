import type { SessionSurface } from '@agent-device/contracts/session';
import {
  isIosFamily,
  isSerialAddressablePlatform,
  publicPlatformString,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import type { SessionRuntimeHints, SessionState } from '../types.ts';
import { successText } from '@agent-device/kernel/success-text';
import type { StartupPerfSample } from './session-startup-metrics.ts';
import type { DeviceSelectionResult } from '../../core/device-selection-resolver.ts';

export function buildOpenResult(params: {
  sessionName: string;
  sessionStateDir: string;
  runnerLogPath: string;
  requestLogPath: string;
  eventLogPath: string;
  appName?: string;
  appBundleId?: string;
  surface: SessionSurface;
  startup?: StartupPerfSample;
  timing?: Record<string, unknown>;
  device?: DeviceInfo;
  runtime?: SessionRuntimeHints;
  runtimeHintCount: (runtime: SessionRuntimeHints) => number;
  sessionReused: boolean;
  selection?: DeviceSelectionResult;
}): Record<string, unknown> {
  const {
    sessionName,
    sessionStateDir,
    runnerLogPath,
    requestLogPath,
    eventLogPath,
    appName,
    appBundleId,
    surface,
    startup,
    timing,
    device,
    runtime,
    runtimeHintCount,
    sessionReused,
    selection,
  } = params;
  const result: Record<string, unknown> = {
    session: sessionName,
    surface,
    sessionStateDir,
    runnerLogPath,
    requestLogPath,
    eventLogPath,
    sessionReused,
    ...selectionResponseData(selection),
  };
  if (appName) result.appName = appName;
  if (appBundleId) result.appBundleId = appBundleId;
  if (startup) result.startup = startup;
  if (timing) result.timing = timing;
  if (runtime && runtimeHintCount(runtime) > 0) {
    result.runtime = runtime;
  }
  if (device) {
    result.platform = publicPlatformString(device);
    result.target = device.target ?? 'mobile';
    result.device = device.name;
    result.id = device.id;
    result.kind = device.kind;
    if (isSerialAddressablePlatform(device.platform)) {
      result.serial = device.id;
    }
  }
  if (device && isIosFamily(device)) {
    result.device_udid = device.id;
    result.ios_simulator_device_set = device.simulatorSetPath ?? null;
  }
  return {
    ...result,
    ...successText(`Opened: ${appName ?? appBundleId ?? sessionName}`),
  };
}

function selectionResponseData(
  selection: DeviceSelectionResult | undefined,
): Record<string, unknown> {
  if (!selection) return {};
  const { device: _device, ...metadata } = selection;
  return { selection: metadata };
}

export function buildNextOpenSession(params: {
  existingSession?: SessionState;
  sessionName: string;
  sessionScope?: SessionState['sessionScope'];
  device: DeviceInfo;
  surface: SessionSurface;
  appBundleId?: string;
  appName?: string;
}): SessionState {
  const { existingSession, sessionName, sessionScope, device, surface, appBundleId, appName } =
    params;
  if (existingSession) {
    return {
      ...existingSession,
      device,
      surface,
      appBundleId,
      appName,
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
    actions: [],
  };
}
