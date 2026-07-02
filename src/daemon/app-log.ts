import fs from 'node:fs';
import path from 'node:path';
import { isIosFamily, isMacOs, type DeviceInfo } from '../kernel/device.ts';
import { AppError } from '../kernel/errors.ts';
import { tryGetPlugin } from '../core/platform-plugin/plugin.ts';
import { registerBuiltinPlatformPlugins } from '../core/interactors/register-builtins.ts';
import { runCmd } from '../utils/exec.ts';
import { runXcrun } from '../platforms/apple/core/tool-provider.ts';
import { runAndroidAdb } from '../platforms/android/adb.ts';
import { createScopedProvider } from '../utils/scoped-provider.ts';
import {
  assertAndroidPackageArgSafe,
  readTrackedAndroidLogcatPid,
  readRecentAndroidLogcatForPackage,
  resolveAndroidPid,
  startAndroidAppLog,
} from './app-log-android.ts';
import {
  checkIosDeviceLogStreamSupport,
  readRecentIosSimulatorLogShowForBundle,
  startIosDeviceAppLog,
  startIosSimulatorAppLog,
  startMacOsAppLog,
} from './app-log-ios.ts';
import { APP_LOG_PID_FILENAME, type AppLogResult, type AppLogState } from './app-log-process.ts';
import { waitForChildExit } from './app-log-stream.ts';
import {
  mergeNetworkDumps,
  readRecentNetworkTraffic,
  readRecentNetworkTrafficFromText,
  type NetworkDump,
  type NetworkIncludeMode,
  type LogBackend,
} from './network-log.ts';

// Populate the PlatformPlugin registry once at module load (idempotent; registers
// only lazy closures, so no leaf code is imported and CLI cold-start is unaffected
// — mirrors the same call in `core/capabilities.ts`). `resolveLogBackend` reads the
// per-platform app-log facet from this registry, so it must be populated first.
registerBuiltinPlatformPlugins();

export type { AppLogResult } from './app-log-process.ts';
export type { AppLogState } from './app-log-process.ts';
export type { AppLogFailure } from './app-log-process.ts';
export { APP_LOG_PID_FILENAME, cleanupStaleAppLogProcesses } from './app-log-process.ts';
export {
  assertAndroidPackageArgSafe,
  readRecentAndroidLogcatForPackage,
} from './app-log-android.ts';
export {
  buildAppleLogPredicate,
  buildIosDeviceLogStreamArgs,
  buildIosSimulatorLogStreamArgs,
} from './app-log-ios.ts';

export type AppLogDoctorResult = {
  checks: Record<string, boolean>;
  notes: string[];
};

export type SessionNetworkCapture = {
  backend: LogBackend;
  dump: NetworkDump;
  notes: string[];
};

type AndroidNetworkRecoveryContext = {
  reason: 'inactive' | 'stale-active';
  trackedPid?: string;
};

type IosSimulatorNetworkRecovery = {
  dump: NetworkDump;
  recoveredLineCount: number;
};

export type AppLogStartRequest = {
  device: DeviceInfo;
  appBundleId: string;
  outPath: string;
  pidPath?: string;
};

type SessionNetworkCaptureParams = {
  device: DeviceInfo;
  appBundleId?: string;
  appLogState?: AppLogState;
  appLogStartedAt?: number;
  appLogPath: string;
  maxEntries: number;
  include: NetworkIncludeMode;
  maxPayloadChars: number;
  maxScanLines: number;
};

export type AppLogProvider = {
  start(request: AppLogStartRequest): Promise<AppLogResult>;
};

const DEFAULT_MAX_APP_LOG_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_ROTATED_FILES = 1;

const localAppLogProvider: AppLogProvider = {
  start: async (request) => await startLocalAppLog(request),
};

const appLogProviderScope = createScopedProvider(localAppLogProvider, createLocalAppLogProvider);

function createLocalAppLogProvider(provider: Partial<AppLogProvider> = {}): AppLogProvider {
  return {
    ...localAppLogProvider,
    ...provider,
  };
}

function resolveAppLogProvider(provider?: AppLogProvider): AppLogProvider {
  return appLogProviderScope.resolve(provider);
}

export async function withAppLogProvider<T>(
  provider: AppLogProvider | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return await appLogProviderScope.run(provider, fn);
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getAppLogConfig(): { maxBytes: number; maxRotatedFiles: number } {
  return {
    maxBytes: parsePositiveIntEnv('AGENT_DEVICE_APP_LOG_MAX_BYTES', DEFAULT_MAX_APP_LOG_BYTES),
    maxRotatedFiles: parsePositiveIntEnv(
      'AGENT_DEVICE_APP_LOG_MAX_FILES',
      DEFAULT_MAX_ROTATED_FILES,
    ),
  };
}

function getAppLogRedactionPatterns(): RegExp[] {
  const raw = process.env.AGENT_DEVICE_APP_LOG_REDACT_PATTERNS;
  if (!raw) return [];
  const patterns = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const result: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      result.push(new RegExp(pattern, 'gi'));
    } catch {
      // Skip invalid user pattern.
    }
  }
  return result;
}

export function rotateAppLogIfNeeded(
  outPath: string,
  config: { maxBytes: number; maxRotatedFiles: number },
): void {
  if (!fs.existsSync(outPath)) return;
  const stats = fs.statSync(outPath);
  if (stats.size < config.maxBytes) return;

  for (let index = config.maxRotatedFiles; index >= 1; index -= 1) {
    const from = index === 1 ? outPath : `${outPath}.${index - 1}`;
    const to = `${outPath}.${index}`;
    if (!fs.existsSync(from)) continue;
    if (fs.existsSync(to)) fs.unlinkSync(to);
    fs.renameSync(from, to);
  }
}

function ensureLogPath(outPath: string): void {
  const dir = path.dirname(outPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  rotateAppLogIfNeeded(outPath, getAppLogConfig());
}

export function getAppLogPathMetadata(outPath: string): {
  exists: boolean;
  sizeBytes: number;
  modifiedAt?: string;
} {
  if (!fs.existsSync(outPath)) {
    return { exists: false, sizeBytes: 0 };
  }
  const stats = fs.statSync(outPath);
  return {
    exists: true,
    sizeBytes: stats.size,
    modifiedAt: stats.mtime.toISOString(),
  };
}

export function resolveLogBackend(device: DeviceInfo): LogBackend {
  // Routes the platform branch through the PlatformPlugin app-log facet (issue
  // #974). Apple/Android carry a `resolveBackend`; linux/web (and any unregistered
  // platform) fall through to the historical `'android'` default. The daemon
  // app-log routing parity test pins this against the former hand branch.
  return tryGetPlugin(device.platform)?.appLog?.resolveBackend(device) ?? 'android';
}

export async function readSessionNetworkCapture(
  params: SessionNetworkCaptureParams,
): Promise<SessionNetworkCapture> {
  const { device, appLogState } = params;
  const backend = resolveLogBackend(device);
  let dump = readSessionAppNetworkDump(params, backend);
  const notes: string[] = [];

  const androidRecovery = await recoverAndroidNetworkDump(params, dump);
  if (androidRecovery) {
    dump = androidRecovery.dump;
    notes.push(androidRecovery.note);
  }

  const iosRecovery = await recoverIosSimulatorNetworkDump(params, dump);
  if (iosRecovery) {
    dump = iosRecovery.dump;
    notes.push(...iosRecovery.notes);
  }

  notes.push(...buildAppLogStateNotes(device, appLogState, notes.length > 0));

  if (dump.entries.length === 0) {
    notes.push(buildNoHttpEntriesNote(device));
  }

  return { backend, dump, notes };
}

function readSessionAppNetworkDump(
  params: SessionNetworkCaptureParams,
  backend: LogBackend,
): NetworkDump {
  return readRecentNetworkTraffic(params.appLogPath, {
    backend,
    maxEntries: params.maxEntries,
    include: params.include,
    maxPayloadChars: params.maxPayloadChars,
    maxScanLines: params.maxScanLines,
  });
}

async function recoverAndroidNetworkDump(
  params: SessionNetworkCaptureParams,
  currentDump: NetworkDump,
): Promise<{ dump: NetworkDump; note: string } | null> {
  const recovery = await resolveAndroidNetworkRecoveryContext(params);
  if (!recovery || !params.appBundleId) return null;

  const recovered = await readRecentAndroidLogcatForPackage(params.device.id, params.appBundleId);
  if (!recovered) return null;

  const recoveredDump = readRecentNetworkTrafficFromText(recovered.text, {
    path: `${params.appLogPath} (adb logcat recovery)`,
    backend: 'android',
    maxEntries: params.maxEntries,
    include: params.include,
    maxPayloadChars: params.maxPayloadChars,
    maxScanLines: params.maxScanLines,
  });
  if (recoveredDump.entries.length === 0) return null;

  return {
    dump: mergeNetworkDumps(recoveredDump, currentDump, params.maxEntries),
    note: buildAndroidRecoveryNote(recovery, recovered.recoveredPids),
  };
}

async function recoverIosSimulatorNetworkDump(
  params: SessionNetworkCaptureParams,
  currentDump: NetworkDump,
): Promise<{ dump: NetworkDump; notes: string[] } | null> {
  if (!canRecoverIosSimulatorLogShow(params, currentDump)) return null;

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
  if (!recovered) return null;

  return {
    dump:
      recovered.dump.entries.length > 0
        ? mergeNetworkDumps(recovered.dump, currentDump, params.maxEntries)
        : currentDump,
    notes: buildIosSimulatorRecoveryNotes(recovered),
  };
}

function canRecoverIosSimulatorLogShow(
  params: SessionNetworkCaptureParams,
  dump: NetworkDump,
): boolean {
  return (
    isIosFamily(params.device) &&
    params.device.kind === 'simulator' &&
    Boolean(params.appBundleId) &&
    dump.entries.length === 0
  );
}

function buildIosSimulatorRecoveryNotes(recovered: IosSimulatorNetworkRecovery): string[] {
  if (recovered.dump.entries.length > 0) {
    return [
      `Recovered ${recovered.dump.entries.length} iOS simulator HTTP entr${
        recovered.dump.entries.length === 1 ? 'y' : 'ies'
      } from simctl log show (${recovered.recoveredLineCount} app log lines scanned).`,
    ];
  }
  if (recovered.recoveredLineCount > 0) {
    return [
      `Recovered ${recovered.recoveredLineCount} recent iOS simulator app log lines from simctl log show, but none looked like HTTP traffic. This app may not emit request URLs, status, or timing into Unified Logging for this repro window.`,
    ];
  }
  return [];
}

function buildAppLogStateNotes(
  device: DeviceInfo,
  appLogState: AppLogState | undefined,
  alreadyRecovered: boolean,
): string[] {
  if (appLogState === undefined) {
    return [
      'Capture uses the session app log file. For fresh traffic, run logs clear --restart before reproducing requests.',
    ];
  }
  if (appLogState === 'active' || alreadyRecovered) return [];
  if (isIosFamily(device) && device.kind === 'simulator') {
    return [
      'Session app log stream is inactive. The iOS simulator recovery path scanned recent simctl log history, but a fresh logs clear --restart window is still the most reliable repro loop.',
    ];
  }
  return [
    'Session app log stream is inactive. Run logs clear --restart, reproduce the request window again, then rerun network dump.',
  ];
}

async function resolveAndroidNetworkRecoveryContext(params: {
  device: DeviceInfo;
  appBundleId?: string;
  appLogPath: string;
  appLogState?: AppLogState;
}): Promise<AndroidNetworkRecoveryContext | null> {
  const { device, appBundleId, appLogPath, appLogState } = params;
  if (device.platform !== 'android' || !appBundleId) {
    return null;
  }
  if (appLogState !== undefined && appLogState !== 'active') {
    return { reason: 'inactive' };
  }
  if (appLogState !== 'active') {
    return null;
  }

  const trackedPid = readTrackedAndroidLogcatPid(
    path.join(path.dirname(appLogPath), APP_LOG_PID_FILENAME),
  );
  if (!trackedPid) {
    return null;
  }
  const currentPid = await resolveAndroidPid(device.id, appBundleId);
  if (!currentPid || currentPid === trackedPid) {
    return null;
  }
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

export async function startAppLog(
  device: DeviceInfo,
  appBundleId: string,
  outPath: string,
  pidPath?: string,
): Promise<AppLogResult> {
  return await resolveAppLogProvider().start({ device, appBundleId, outPath, pidPath });
}

async function startLocalAppLog({
  device,
  appBundleId,
  outPath,
  pidPath,
}: AppLogStartRequest): Promise<AppLogResult> {
  ensureLogPath(outPath);
  const stream = fs.createWriteStream(outPath, { flags: 'a' });
  const redactionPatterns = getAppLogRedactionPatterns();
  if (isIosFamily(device)) {
    if (device.kind === 'device') {
      return await startIosDeviceAppLog(device.id, stream, redactionPatterns, pidPath);
    }
    return await startIosSimulatorAppLog(
      device.id,
      appBundleId,
      stream,
      redactionPatterns,
      device.simulatorSetPath,
      pidPath,
    );
  }
  if (device.platform === 'android') {
    assertAndroidPackageArgSafe(appBundleId);
    return await startAndroidAppLog(device.id, appBundleId, stream, redactionPatterns, pidPath);
  }
  if (isMacOs(device)) {
    return await startMacOsAppLog(appBundleId, stream, redactionPatterns, pidPath);
  }
  stream.end();
  throw new AppError('UNSUPPORTED_PLATFORM', `unsupported platform: ${device.platform}`);
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
  if (!recovered) {
    return null;
  }
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

export async function stopAppLog(appLog: AppLogResult): Promise<void> {
  await appLog.stop();
  await waitForChildExit(appLog.wait);
}

export async function runAppLogDoctor(
  device: DeviceInfo,
  appBundleId?: string,
): Promise<AppLogDoctorResult> {
  const checks: Record<string, boolean> = {};
  const notes: string[] = [];
  if (!appBundleId) {
    notes.push(
      'No app bundle is tracked in this session. Run open <app> first for app-scoped logs.',
    );
  }
  if (device.platform === 'android') {
    Object.assign(checks, await runAndroidAppLogDoctor(device, appBundleId));
  }
  if (isIosFamily(device) && device.kind === 'simulator') {
    Object.assign(checks, await runIosSimulatorAppLogDoctor());
  }
  if (isIosFamily(device) && device.kind === 'device') {
    const result = await runIosDeviceAppLogDoctor();
    Object.assign(checks, result.checks);
    notes.push(...result.notes);
  }
  if (isMacOs(device)) {
    Object.assign(checks, await runMacOsAppLogDoctor());
  }
  return { checks, notes };
}

async function runAndroidAppLogDoctor(
  device: DeviceInfo,
  appBundleId?: string,
): Promise<Record<string, boolean>> {
  const checks: Record<string, boolean> = {};
  try {
    const adb = await runAndroidAdb(device, ['shell', 'echo', 'ok'], {
      allowFailure: true,
      timeoutMs: 1_000,
    });
    checks.adbAvailable = adb.exitCode === 0;
  } catch {
    checks.adbAvailable = false;
  }
  if (!appBundleId) return checks;

  try {
    const pidof = await runAndroidAdb(device, ['shell', 'pidof', appBundleId], {
      allowFailure: true,
      timeoutMs: 1_000,
    });
    checks.androidPidVisible = pidof.stdout.trim().length > 0;
  } catch {
    checks.androidPidVisible = false;
  }
  return checks;
}

async function runIosSimulatorAppLogDoctor(): Promise<Record<string, boolean>> {
  try {
    const simctl = await runXcrun(['simctl', 'help'], { allowFailure: true });
    return { simctlAvailable: simctl.exitCode === 0 };
  } catch {
    return { simctlAvailable: false };
  }
}

async function runIosDeviceAppLogDoctor(): Promise<AppLogDoctorResult> {
  const checks: Record<string, boolean> = {};
  const notes: string[] = [];
  try {
    const devicectl = await runXcrun(['devicectl', '--version'], { allowFailure: true });
    checks.devicectlAvailable = devicectl.exitCode === 0;
  } catch {
    checks.devicectlAvailable = false;
  }
  if (!checks.devicectlAvailable) return { checks, notes };

  const logStream = await checkIosDeviceLogStreamSupport();
  checks.devicectlDeviceLogStream = logStream.supported;
  if (!logStream.supported) {
    notes.push(
      'Installed devicectl does not expose a scriptable iOS physical-device app log stream. Markers can still be written, but app output is not being captured by agent-device on this toolchain.',
    );
  }
  return { checks, notes };
}

async function runMacOsAppLogDoctor(): Promise<Record<string, boolean>> {
  try {
    const log = await runCmd('log', ['help'], { allowFailure: true });
    return { logAvailable: log.exitCode === 0 };
  } catch {
    return { logAvailable: false };
  }
}

export function appendAppLogMarker(outPath: string, marker: string): void {
  ensureLogPath(outPath);
  const line = `[agent-device][mark][${new Date().toISOString()}] ${marker.trim() || 'marker'}\n`;
  fs.appendFileSync(outPath, line, 'utf8');
}

export function clearAppLogFiles(outPath: string): {
  path: string;
  cleared: boolean;
  removedRotatedFiles: number;
} {
  const dir = path.dirname(outPath);
  const base = path.basename(outPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(outPath)) {
    fs.truncateSync(outPath, 0);
  } else {
    fs.writeFileSync(outPath, '', 'utf8');
  }
  let removedRotatedFiles = 0;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.startsWith(`${base}.`)) continue;
    const suffix = entry.slice(base.length + 1);
    if (!/^\d+$/.test(suffix)) continue;
    try {
      fs.unlinkSync(path.join(dir, entry));
      removedRotatedFiles += 1;
    } catch {
      // best-effort cleanup
    }
  }
  return { path: outPath, cleared: true, removedRotatedFiles };
}
