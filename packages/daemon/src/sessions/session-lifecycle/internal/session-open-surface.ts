import type {
  LaunchConfirmationUnansweredReason,
  OpenApplicationOutcome,
  OpenForegroundVerification,
} from '@agent-device/contracts/application-lifecycle-runtime';
import type { TakenOverDeviceClaim } from '@agent-device/daemon-contracts/device-claims';
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
import { appendResponseWarning } from './session-open-warnings.ts';

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
  outcome?: OpenApplicationOutcome;
  tookOverDeviceClaim?: TakenOverDeviceClaim;
  hidePreviousClaimOwner?: boolean;
  replacedRuntimeHintsWarning?: string;
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
    outcome,
    tookOverDeviceClaim,
    hidePreviousClaimOwner,
    replacedRuntimeHintsWarning,
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
  const confirmationWarning = outcome && projectLaunchConfirmation(result, outcome);
  if (runtime && runtimeHintCount(runtime) > 0) result.runtime = runtime;
  if (device) Object.assign(result, deviceResponseData(device));
  Object.assign(result, successText(`Opened: ${appName ?? appBundleId ?? sessionName}`));

  for (const warning of [
    deviceClaimTakeoverWarning(tookOverDeviceClaim, hidePreviousClaimOwner),
    replacedRuntimeHintsWarning,
    confirmationWarning,
    openForegroundWarning(outcome?.timing.foregroundVerification),
    outcome?.alreadyForeground
      ? 'App was already foreground; open re-activated it without restarting. Use --relaunch to restart.'
      : undefined,
  ]) {
    if (warning) appendResponseWarning(result, warning);
  }
  return result;
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

/**
 * Keep the previous claim owner's identity private for a `macos-app` lease tenant.
 */
function deviceClaimTakeoverWarning(
  tookOver: TakenOverDeviceClaim | undefined,
  hidePreviousClaimOwner = false,
): string | undefined {
  if (!tookOver) return undefined;
  if (hidePreviousClaimOwner) {
    return 'Took the device over: it rebooted after its previous claim was taken, so the previous app was already gone.';
  }
  return (
    `Took the device from session "${tookOver.session}" in workspace "${tookOver.workspace}": ` +
    'that device rebooted after its claim was taken, so its app and runner were already gone.'
  );
}

function projectLaunchConfirmation(
  result: Record<string, unknown>,
  outcome: OpenApplicationOutcome,
): string | undefined {
  switch (outcome.launchConfirmation) {
    case 'accepted':
      result.launchConfirmation = 'accepted';
      return undefined;
    case 'unanswered':
      result.launchConfirmation = 'unanswered';
      result.launchConfirmationReason = outcome.launchConfirmationReason;
      return launchConfirmationUnansweredWarning(outcome.launchConfirmationReason);
    case undefined:
      if (!outcome.launchConfirmationProbeFailure) return undefined;
      result.launchConfirmationProbeFailure = outcome.launchConfirmationProbeFailure;
      return (
        'agent-device could not read whether iOS is asking to confirm the launch URL, so the launch ' +
        'URL may still be held by a prompt. Check with `alert get` before retrying.'
      );
  }
}

function launchConfirmationUnansweredWarning(reason: LaunchConfirmationUnansweredReason): string {
  if (reason === 'url-owner-unresolved') {
    return (
      'iOS is still holding the launch confirmation and the installed app that owns the launch ' +
      "URL's scheme could not be resolved, so this launch URL has not reached the app. Answer it " +
      'with `alert accept`.'
    );
  }
  return (
    'iOS shows an alert this open did not recognize (alert-unrecognized), so it left the launch ' +
    'URL unconfirmed. The alert can be the launch confirmation in another language, or an alert ' +
    "of the app's own, such as a permission prompt. Read it with `alert get`. Answer with " +
    '`alert accept` only when it is the launch confirmation; answer any other alert on its own ' +
    'terms.'
  );
}

function openForegroundWarning(
  verification: OpenForegroundVerification | undefined,
): string | undefined {
  if (!verification) return undefined;
  if (verification.state === 'probe-failed') {
    return (
      'The launch dispatch succeeded, but the foreground probe could not read the device within 5s ' +
      '(open-foreground-probe-unreadable). This claims nothing about whether the app reached the ' +
      'foreground; check the device connection, then run the open again.'
    );
  }
  const read =
    verification.state === 'other-foreground'
      ? `HarmonyOS read that the foreground app stayed "${verification.foregroundPackage}"`
      : 'HarmonyOS read no mission in the foreground';
  return (
    `The launch dispatch succeeded, but ${read} within 5s of the launch ` +
    '(open-not-foreground). A lock screen over the device is a typical cause. Unlock the device, ' +
    'then run the open again.'
  );
}
