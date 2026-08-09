import path from 'node:path';
import type { LogBackend } from '@agent-device/contracts/observability';
import { isIosFamily, isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import {
  readRecentAndroidLogcatForPackage,
  readTrackedAndroidLogcatPid,
  resolveAndroidPid,
} from './network-log-android-recovery.ts';
import { readRecentIosSimulatorLogShowForBundle } from './network-log-ios-simulator-recovery.ts';
import {
  mergeNetworkDumps,
  readRecentNetworkTraffic,
  readRecentNetworkTrafficFromText,
  type NetworkDump,
  type NetworkIncludeMode,
} from './network-log.ts';

const APP_LOG_PID_FILENAME = 'app-log.pid';
type NetworkAppLogState = 'active' | 'recovering' | 'ended' | 'failed';

export type SessionNetworkCapture = {
  backend: LogBackend;
  dump: NetworkDump;
  notes: string[];
};

type SessionNetworkCaptureParams = {
  device: DeviceInfo;
  appBundleId?: string;
  appLogState?: NetworkAppLogState;
  appLogStartedAt?: number;
  appLogPath: string;
  maxEntries: number;
  include: NetworkIncludeMode;
  maxPayloadChars: number;
  maxScanLines: number;
};

type AndroidNetworkRecoveryContext = {
  reason: 'inactive' | 'stale-active';
  trackedPid?: string;
};

type IosSimulatorNetworkRecovery = {
  dump: NetworkDump;
  recoveredLineCount: number;
};

type NetworkRecoveryResult = {
  dump: NetworkDump;
  note?: string;
};

function resolveLegacyNetworkLogBackend(device: DeviceInfo): LogBackend {
  if (isIosFamily(device)) return device.kind === 'simulator' ? 'ios-simulator' : 'ios-device';
  if (isMacOs(device)) return 'macos';
  if (device.platform === 'harmonyos') return 'harmonyos';
  return 'android';
}

export async function readSessionNetworkCapture(
  params: SessionNetworkCaptureParams,
): Promise<SessionNetworkCapture> {
  const backend = resolveLegacyNetworkLogBackend(params.device);
  let dump = readRecentNetworkTraffic(params.appLogPath, {
    backend,
    maxEntries: params.maxEntries,
    include: params.include,
    maxPayloadChars: params.maxPayloadChars,
    maxScanLines: params.maxScanLines,
  });
  const notes: string[] = [];

  const android = await recoverAndroidNetworkCapture(params, dump);
  dump = android.dump;
  appendNetworkNote(notes, android.note);
  const iosSimulator = await recoverIosSimulatorNetworkCapture(params, dump);
  dump = iosSimulator.dump;
  appendNetworkNote(notes, iosSimulator.note);
  appendNetworkNote(notes, buildNetworkLifecycleNote(params, notes.length));
  appendNetworkNote(
    notes,
    dump.entries.length === 0 ? buildNoHttpEntriesNote(params.device) : null,
  );
  return { backend, dump, notes };
}

async function recoverAndroidNetworkCapture(
  params: SessionNetworkCaptureParams,
  dump: NetworkDump,
): Promise<NetworkRecoveryResult> {
  const context = await resolveAndroidNetworkRecoveryContext(params);
  if (!context || !params.appBundleId) return { dump };
  const recovered = await readRecentAndroidLogcatForPackage(params.device.id, params.appBundleId);
  if (!recovered) return { dump };
  const recoveredDump = readRecentNetworkTrafficFromText(recovered.text, {
    path: `${params.appLogPath} (adb logcat recovery)`,
    backend: 'android',
    maxEntries: params.maxEntries,
    include: params.include,
    maxPayloadChars: params.maxPayloadChars,
    maxScanLines: params.maxScanLines,
  });
  if (recoveredDump.entries.length === 0) return { dump };
  return {
    dump: mergeNetworkDumps(recoveredDump, dump, params.maxEntries),
    note: buildAndroidRecoveryNote(context, recovered.recoveredPids),
  };
}

async function recoverIosSimulatorNetworkCapture(
  params: SessionNetworkCaptureParams,
  dump: NetworkDump,
): Promise<NetworkRecoveryResult> {
  if (!canRecoverIosSimulatorCapture(params) || dump.entries.length > 0) return { dump };
  const recovered = await readRecentIosSimulatorNetworkCapture({
    deviceId: params.device.id,
    appBundleId: params.appBundleId as string,
    startedAt: params.appLogStartedAt,
    simulatorSetPath: params.device.simulatorSetPath,
    appLogPath: params.appLogPath,
    maxEntries: params.maxEntries,
    include: params.include,
    maxPayloadChars: params.maxPayloadChars,
    maxScanLines: params.maxScanLines,
  });
  if (!recovered) return { dump };
  if (recovered.dump.entries.length === 0) {
    return { dump, note: buildEmptyIosSimulatorRecoveryNote(recovered.recoveredLineCount) };
  }
  return {
    dump: mergeNetworkDumps(recovered.dump, dump, params.maxEntries),
    note: buildIosSimulatorRecoveryNote(recovered),
  };
}

function canRecoverIosSimulatorCapture(params: SessionNetworkCaptureParams): boolean {
  return (
    isIosFamily(params.device) && params.device.kind === 'simulator' && Boolean(params.appBundleId)
  );
}

function buildIosSimulatorRecoveryNote(recovered: IosSimulatorNetworkRecovery): string {
  const entryCount = recovered.dump.entries.length;
  return `Recovered ${entryCount} iOS simulator HTTP entr${
    entryCount === 1 ? 'y' : 'ies'
  } from simctl log show (${recovered.recoveredLineCount} app log lines scanned).`;
}

function buildEmptyIosSimulatorRecoveryNote(recoveredLineCount: number): string | undefined {
  if (recoveredLineCount === 0) return undefined;
  return `Recovered ${recoveredLineCount} recent iOS simulator app log lines from simctl log show, but none looked like HTTP traffic. This app may not emit request URLs, status, or timing into Unified Logging for this repro window.`;
}

function buildNetworkLifecycleNote(
  params: SessionNetworkCaptureParams,
  recoveryNoteCount: number,
): string | undefined {
  if (params.appLogState === undefined) {
    return 'Capture uses the session app log file. For fresh traffic, run logs clear --restart before reproducing requests.';
  }
  if (params.appLogState === 'active' || recoveryNoteCount > 0) return undefined;
  if (isIosFamily(params.device) && params.device.kind === 'simulator') {
    return 'Session app log stream is inactive. The iOS simulator recovery path scanned recent simctl log history, but a fresh logs clear --restart window is still the most reliable repro loop.';
  }
  return 'Session app log stream is inactive. Run logs clear --restart, reproduce the request window again, then rerun network dump.';
}

function appendNetworkNote(notes: string[], note: string | null | undefined): void {
  if (note) notes.push(note);
}

async function resolveAndroidNetworkRecoveryContext(params: {
  device: DeviceInfo;
  appBundleId?: string;
  appLogPath: string;
  appLogState?: NetworkAppLogState;
}): Promise<AndroidNetworkRecoveryContext | null> {
  const { device, appBundleId, appLogPath, appLogState } = params;
  if (device.platform !== 'android' || !appBundleId) return null;
  if (appLogState !== undefined && appLogState !== 'active') return { reason: 'inactive' };
  if (appLogState !== 'active') return null;

  const trackedPid = readTrackedAndroidLogcatPid(
    path.join(path.dirname(appLogPath), APP_LOG_PID_FILENAME),
  );
  if (!trackedPid) return null;
  const currentPid = await resolveAndroidPid(device.id, appBundleId);
  if (!currentPid || currentPid === trackedPid) return null;
  return { reason: 'stale-active', trackedPid };
}

function buildAndroidRecoveryNote(
  context: AndroidNetworkRecoveryContext,
  recoveredPids: string[],
): string {
  if (context.reason === 'stale-active') {
    return `Session app log stream was still bound to prior Android PID ${context.trackedPid}. Recovered recent Android HTTP entries from adb logcat for PID set ${recoveredPids.join(', ')}.`;
  }
  return `Session app log stream was inactive. Recovered recent Android HTTP entries from adb logcat for PID set ${recoveredPids.join(', ')}.`;
}

async function readRecentIosSimulatorNetworkCapture(params: {
  deviceId: string;
  appBundleId: string;
  startedAt?: number;
  simulatorSetPath?: string;
  appLogPath: string;
  maxEntries: number;
  include: NetworkIncludeMode;
  maxPayloadChars: number;
  maxScanLines: number;
}): Promise<IosSimulatorNetworkRecovery | null> {
  const recovered = await readRecentIosSimulatorLogShowForBundle({
    deviceId: params.deviceId,
    appBundleId: params.appBundleId,
    startedAt: params.startedAt,
    simulatorSetPath: params.simulatorSetPath,
  });
  if (!recovered) return null;
  return {
    dump: readRecentNetworkTrafficFromText(recovered.text, {
      path: `${params.appLogPath} (simctl log show recovery)`,
      backend: 'ios-simulator',
      maxEntries: params.maxEntries,
      include: params.include,
      maxPayloadChars: params.maxPayloadChars,
      maxScanLines: params.maxScanLines,
    }),
    recoveredLineCount: recovered.recoveredLineCount,
  };
}

function buildNoHttpEntriesNote(device: DeviceInfo): string {
  if (isIosFamily(device) && device.kind === 'simulator') {
    return 'No HTTP(s) entries were found in recent iOS simulator app logs. If the app only emits non-HTTP diagnostics, inspect logs path or add app-side URLSession/network logging for per-request timing and payload details.';
  }
  if (isIosFamily(device)) {
    return 'No HTTP(s) entries were found in recent iOS device app logs. iOS network dump only sees what the app emits into Unified Logging for this process.';
  }
  return 'No HTTP(s) entries were found in recent session app logs.';
}
