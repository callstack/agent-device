import type {
  LaunchConfirmationAbsent,
  LaunchConfirmationOutcome,
} from '@agent-device/contracts/application-lifecycle-runtime';
import type { SessionSurface } from '@agent-device/contracts/session';
import {
  isIosFamily,
  isSerialAddressablePlatform,
  publicPlatformString,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import type { SessionRuntimeHints } from '../../../core/session-state.ts';
import { successText } from '@agent-device/kernel/success-text';
import type { StartupPerfSample } from './session-startup-metrics.ts';
import type { DeviceSelectionResult } from '@agent-device/device-selection/device-selection-resolver';

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
  launchConfirmation?: LaunchConfirmationOutcome | LaunchConfirmationAbsent;
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
    launchConfirmation,
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
  Object.assign(result, launchConfirmation ?? {});
  if (runtime && runtimeHintCount(runtime) > 0) result.runtime = runtime;
  if (device) Object.assign(result, deviceResponseData(device));
  return {
    ...result,
    ...successText(`Opened: ${appName ?? appBundleId ?? sessionName}`),
  };
}

function deviceResponseData(device: DeviceInfo): Record<string, unknown> {
  const data: Record<string, unknown> = {
    platform: publicPlatformString(device),
    target: device.target ?? 'mobile',
    device: device.name,
    id: device.id,
    kind: device.kind,
  };
  if (device.model) data.model = device.model;
  if (device.osVersion) data.osVersion = device.osVersion;
  if (isSerialAddressablePlatform(device.platform)) data.serial = device.id;
  if (isIosFamily(device)) {
    data.device_udid = device.id;
    data.ios_simulator_device_set = device.simulatorSetPath ?? null;
  }
  return data;
}

function selectionResponseData(
  selection: DeviceSelectionResult | undefined,
): Record<string, unknown> {
  if (!selection) return {};
  const { device: _device, ...metadata } = selection;
  return { selection: metadata };
}
