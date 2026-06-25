import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import { analyzeReactNativeOverlay } from '../../core/react-native-overlay.ts';
import {
  getAndroidAppState,
  resolveAndroidApp,
  type AndroidForegroundApp,
} from '../../platforms/android/app-lifecycle.ts';
import {
  resolveAndroidAdbExecutor,
  type AndroidAdbExecutor,
} from '../../platforms/android/adb-executor.ts';
import { resolveIosApp } from '../../platforms/ios/apps.ts';
import type { DeviceInfo } from '../../utils/device.ts';
import { readVersion } from '../../utils/version.ts';
import { normalizeError } from '../../utils/errors.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { emitRequestProgress } from '../request-progress.ts';
import { resolveCommandDevice } from './session-device-utils.ts';

type DoctorStatus = 'pass' | 'warn' | 'fail' | 'info';
type DoctorKind = 'auto' | 'react-native' | 'expo';
type DoctorOptions = {
  targetApp?: string;
  metroHost: string;
  metroPort: number;
  kind: DoctorKind;
  shouldProbeMetro: boolean;
};

type DoctorCheck = {
  id: string;
  status: DoctorStatus;
  summary: string;
  hint?: string;
  command?: string;
  evidence?: Record<string, unknown>;
};

const DEFAULT_METRO_HOST = '127.0.0.1';
const DEFAULT_METRO_PORT = 8081;
const METRO_PROBE_TIMEOUT_MS = 1500;
const ANDROID_PROBE_TIMEOUT_MS = 2000;
const ANDROID_LAUNCHER_PACKAGES = new Set([
  'com.android.launcher',
  'com.android.launcher3',
  'com.google.android.apps.nexuslauncher',
]);

export async function handleDoctorCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  androidAdbExecutor?: AndroidAdbExecutor;
}): Promise<DaemonResponse | null> {
  const { req, sessionName, sessionStore, androidAdbExecutor } = params;
  if (req.command !== PUBLIC_COMMANDS.doctor) return null;

  const session = sessionStore.get(sessionName);
  const options = readDoctorOptions(req, session);
  const checks: DoctorCheck[] = [];
  appendDoctorChecks(
    checks,
    {
      id: 'agent-device',
      status: 'pass',
      summary: `agent-device ${readVersion()} using ${sessionStore.resolveStateDir()}`,
      evidence: { version: readVersion(), stateDir: sessionStore.resolveStateDir() },
    },
    ...sessionChecks(sessionStore, sessionName, session),
  );

  const device = await appendDeviceCheck(checks, req, session);
  if (device) {
    appendDoctorCheck(checks, deviceReadinessCheck(device));
    appendDoctorChecks(checks, ...platformScopeChecks(device, options));
    await appendAppChecks(checks, { device, session, targetApp: options.targetApp });
    await appendAndroidChecks(checks, {
      device,
      session,
      targetApp: options.targetApp,
      metroPort: options.metroPort,
      androidAdbExecutor,
    });
    appendReactNativeOverlayCheck(checks, session, options);
  }
  if (options.shouldProbeMetro) {
    appendDoctorCheck(checks, await probeMetro(options.metroHost, options.metroPort, options.kind));
  }

  const status = summarizeDoctorStatus(checks);
  return {
    ok: true,
    data: {
      status,
      summary: doctorSummary(status),
      kind: options.kind,
      platform: device?.platform,
      target: device?.target ?? 'mobile',
      targetApp: options.targetApp,
      metro: options.shouldProbeMetro
        ? { host: options.metroHost, port: options.metroPort }
        : undefined,
      checks: sortChecks(checks),
    },
  };
}

function readDoctorOptions(req: DaemonRequest, session: SessionState | undefined): DoctorOptions {
  const kind = readDoctorKind(req.flags?.kind);
  const targetApp = readNonEmptyString(req.flags?.targetApp) ?? session?.appBundleId;
  const metroHost = readNonEmptyString(req.flags?.metroHost) ?? DEFAULT_METRO_HOST;
  const metroPort = readPositivePort(req.flags?.metroPort) ?? DEFAULT_METRO_PORT;
  return {
    targetApp,
    metroHost,
    metroPort,
    kind,
    shouldProbeMetro: shouldProbeMetro(req.flags, kind),
  };
}

function readDoctorKind(value: unknown): DoctorKind {
  return value === 'expo' || value === 'react-native' ? value : 'auto';
}

function shouldProbeMetro(flags: DaemonRequest['flags'], kind: DoctorKind): boolean {
  return (
    kind !== 'auto' || typeof flags?.metroPort === 'number' || typeof flags?.metroHost === 'string'
  );
}

function sessionChecks(
  sessionStore: SessionStore,
  sessionName: string,
  session: SessionState | undefined,
): DoctorCheck[] {
  const sameDeviceSessions = session
    ? sessionStore
        .toArray()
        .filter(
          (candidate) =>
            candidate.name !== session.name &&
            candidate.device.platform === session.device.platform &&
            candidate.device.id === session.device.id,
        )
        .map((candidate) => candidate.name)
    : [];

  if (!session) {
    return [
      {
        id: 'session',
        status: 'info',
        summary: `No active session named ${sessionName}. Doctor will use the selected device.`,
        hint: 'This is expected before a run. Use open when app foreground state matters.',
      },
    ];
  }

  return [
    {
      id: 'session',
      status: sameDeviceSessions.length > 0 ? 'warn' : 'pass',
      summary:
        sameDeviceSessions.length > 0
          ? `Other active sessions target the same device: ${sameDeviceSessions.join(', ')}`
          : `Active session ${session.name} targets ${session.device.name}`,
      hint:
        sameDeviceSessions.length > 0
          ? 'Close stale sessions before a QA run if they belong to old attempts.'
          : undefined,
      command:
        sameDeviceSessions.length > 0
          ? `agent-device close --session ${sameDeviceSessions[0]} --platform ${session.device.platform}`
          : undefined,
      evidence: {
        session: session.name,
        sameDeviceSessions,
        sessionStateDir: sessionStore.resolveSessionDir(session.name),
      },
    },
  ];
}

async function appendDeviceCheck(
  checks: DoctorCheck[],
  req: DaemonRequest,
  session: SessionState | undefined,
): Promise<DeviceInfo | undefined> {
  try {
    const device = await resolveCommandDevice({ session, flags: req.flags, ensureReady: false });
    appendDoctorCheck(checks, {
      id: 'device',
      status: 'pass',
      summary: `Selected ${device.name} (${device.platform}${device.target ? `/${device.target}` : ''})`,
      evidence: {
        id: device.id,
        name: device.name,
        platform: device.platform,
        kind: device.kind,
        target: device.target ?? 'mobile',
        booted: device.booted,
      },
    });
    return device;
  } catch (error) {
    const normalized = normalizeError(error);
    appendDoctorCheck(checks, {
      id: 'device',
      status: 'fail',
      summary: normalized.message,
      hint: normalized.hint,
      command: 'agent-device devices',
      evidence: { code: normalized.code, details: normalized.details },
    });
    return undefined;
  }
}

function deviceReadinessCheck(device: DeviceInfo): DoctorCheck {
  if (device.booted === false) {
    return {
      id: 'device-readiness',
      status: 'fail',
      summary: `${device.name} is present but not booted.`,
      command: `agent-device boot --platform ${device.platform}`,
      evidence: { booted: false },
    };
  }
  return {
    id: 'device-readiness',
    status: 'pass',
    summary:
      device.booted === true
        ? `${device.name} is booted.`
        : `${device.name} readiness is selected; boot state is not reported for this target.`,
    evidence: { booted: device.booted },
  };
}

function platformScopeChecks(device: DeviceInfo, options: DoctorOptions): DoctorCheck[] {
  if (
    (options.kind === 'react-native' || options.kind === 'expo') &&
    device.platform !== 'ios' &&
    device.platform !== 'android'
  ) {
    return [
      {
        id: 'platform-scope',
        status: 'info',
        summary: `${options.kind} checks are app-mobile focused; ${device.platform} doctor covers device/session readiness only.`,
      },
    ];
  }
  if (device.platform === 'android' && options.kind !== 'auto') {
    return [
      {
        id: 'android-routing',
        status: 'info',
        summary:
          'Android URL opens can use host localhost automatically; package launches may still need adb reverse.',
        command: `adb -s ${device.id} reverse tcp:${options.metroPort} tcp:${options.metroPort}`,
      },
    ];
  }
  return [];
}

async function appendAppChecks(
  checks: DoctorCheck[],
  params: { device: DeviceInfo; session: SessionState | undefined; targetApp?: string },
): Promise<void> {
  const { device, targetApp, session } = params;
  if (!targetApp) {
    appendDoctorCheck(checks, {
      id: 'target-app',
      status: 'info',
      summary: 'No --target-app provided; app install/discovery check skipped.',
      hint: 'Pass --target-app with the package or bundle expected for the run.',
    });
    return;
  }

  try {
    const resolved =
      device.platform === 'android'
        ? (await resolveAndroidApp(device, targetApp)).value
        : device.platform === 'ios' || device.platform === 'macos'
          ? await resolveIosApp(device, targetApp)
          : targetApp;
    appendDoctorCheck(checks, {
      id: 'target-app',
      status: 'pass',
      summary: `Target app is discoverable: ${resolved}`,
      evidence: { requested: targetApp, resolved, sessionApp: session?.appBundleId },
    });
  } catch (error) {
    const normalized = normalizeError(error);
    appendDoctorCheck(checks, {
      id: 'target-app',
      status: 'fail',
      summary: `Target app is not discoverable: ${targetApp}`,
      hint: normalized.hint ?? 'Install the app or pass the exact package/bundle id.',
      command: `agent-device apps --platform ${device.platform}`,
      evidence: { code: normalized.code, message: normalized.message },
    });
  }
}

async function appendAndroidChecks(
  checks: DoctorCheck[],
  params: {
    device: DeviceInfo;
    session: SessionState | undefined;
    targetApp?: string;
    metroPort: number;
    androidAdbExecutor?: AndroidAdbExecutor;
  },
): Promise<void> {
  const { device, session, targetApp, metroPort, androidAdbExecutor } = params;
  if (device.platform !== 'android') return;
  const adb = resolveAndroidAdbExecutor(device, androidAdbExecutor);

  try {
    const state = await getAndroidAppState(device);
    appendDoctorCheck(checks, androidForegroundCheck(state, targetApp ?? session?.appBundleId));
  } catch (error) {
    const normalized = normalizeError(error);
    appendDoctorCheck(checks, {
      id: 'android-foreground',
      status: 'warn',
      summary: 'Could not read Android foreground package.',
      hint: normalized.message,
      evidence: { code: normalized.code },
    });
  }

  appendDoctorCheck(checks, await probeAndroidReverse(adb, device.id, metroPort));
  appendDoctorCheck(checks, await probeAndroidAnimations(adb));
}

function androidForegroundCheck(
  state: AndroidForegroundApp,
  expectedPackage: string | undefined,
): DoctorCheck {
  const foregroundPackage = state.package;
  const onLauncher = isAndroidLauncherPackage(foregroundPackage);
  const mismatch = hasAndroidForegroundMismatch(foregroundPackage, expectedPackage);
  return {
    id: 'android-foreground',
    status: onLauncher || mismatch ? 'warn' : 'pass',
    summary: androidForegroundSummary(foregroundPackage, expectedPackage, onLauncher, mismatch),
    command:
      expectedPackage && (onLauncher || mismatch)
        ? `agent-device open ${expectedPackage} --platform android`
        : undefined,
    evidence: state as Record<string, unknown>,
  };
}

function isAndroidLauncherPackage(packageName: string | undefined): boolean {
  return packageName ? ANDROID_LAUNCHER_PACKAGES.has(packageName) : false;
}

function hasAndroidForegroundMismatch(
  foregroundPackage: string | undefined,
  expectedPackage: string | undefined,
): boolean {
  return expectedPackage !== undefined && foregroundPackage !== expectedPackage;
}

function androidForegroundSummary(
  foregroundPackage: string | undefined,
  expectedPackage: string | undefined,
  onLauncher: boolean,
  mismatch: boolean,
): string {
  const actual = foregroundPackage ?? 'unknown';
  if (onLauncher) return 'Android is on the launcher, not the target app.';
  if (mismatch) return `Android foreground package is ${actual}, expected ${expectedPackage}.`;
  return `Android foreground package is ${actual}.`;
}

async function probeAndroidReverse(
  adb: AndroidAdbExecutor,
  serial: string,
  metroPort: number,
): Promise<DoctorCheck> {
  try {
    const result = await adb(['reverse', '--list'], {
      allowFailure: true,
      timeoutMs: ANDROID_PROBE_TIMEOUT_MS,
    });
    const expected = `tcp:${metroPort} tcp:${metroPort}`;
    const hasReverse = result.stdout.includes(expected);
    return {
      id: 'android-reverse',
      status: hasReverse ? 'pass' : 'warn',
      summary: hasReverse
        ? `Android adb reverse exists for Metro port ${metroPort}.`
        : `Android adb reverse is missing for Metro port ${metroPort}.`,
      command: hasReverse
        ? undefined
        : `adb -s ${serial} reverse tcp:${metroPort} tcp:${metroPort}`,
      evidence: { stdout: result.stdout.trim() },
    };
  } catch (error) {
    const normalized = normalizeError(error);
    return {
      id: 'android-reverse',
      status: 'warn',
      summary: 'Could not inspect Android adb reverse mappings.',
      hint: normalized.message,
      evidence: { code: normalized.code },
    };
  }
}

async function probeAndroidAnimations(adb: AndroidAdbExecutor): Promise<DoctorCheck> {
  const keys = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'];
  try {
    const values: Record<string, string> = {};
    for (const key of keys) {
      const result = await adb(['shell', 'settings', 'get', 'global', key], {
        allowFailure: true,
        timeoutMs: ANDROID_PROBE_TIMEOUT_MS,
      });
      values[key] = result.stdout.trim();
    }
    const enabled = Object.values(values).some((value) => value !== '0' && value !== '0.0');
    return {
      id: 'android-animations',
      status: enabled ? 'warn' : 'pass',
      summary: enabled
        ? 'Android animations are enabled and can slow or flake automation.'
        : 'Android animations are disabled.',
      hint: enabled ? 'Disable animations in emulator settings before long QA runs.' : undefined,
      evidence: values,
    };
  } catch (error) {
    const normalized = normalizeError(error);
    return {
      id: 'android-animations',
      status: 'warn',
      summary: 'Could not read Android animation settings.',
      hint: normalized.message,
      evidence: { code: normalized.code },
    };
  }
}

function appendReactNativeOverlayCheck(
  checks: DoctorCheck[],
  session: SessionState | undefined,
  options: DoctorOptions,
): void {
  const check = reactNativeOverlayCheck(session, options);
  if (check) appendDoctorCheck(checks, check);
}

function reactNativeOverlayCheck(
  session: SessionState | undefined,
  options: DoctorOptions,
): DoctorCheck | undefined {
  if (shouldSkipReactNativeOverlayCheck(session, options)) return undefined;
  if (!session?.snapshot) return missingSnapshotOverlayCheck();

  const overlay = analyzeReactNativeOverlay(session.snapshot.nodes);
  return {
    id: 'rn-overlay',
    status: overlay.detected ? 'warn' : 'pass',
    summary: overlay.detected
      ? `React Native ${overlay.redBox ? 'RedBox' : 'LogBox'} overlay appears in the current snapshot.`
      : 'No React Native overlay detected in the current snapshot.',
    command: overlay.detected ? 'agent-device react-native dismiss-overlay' : undefined,
    evidence: {
      redBox: overlay.redBox,
      dismissTargets: overlay.dismissNodes.length + overlay.collapsedNodes.length,
    },
  };
}

function shouldSkipReactNativeOverlayCheck(
  session: SessionState | undefined,
  options: DoctorOptions,
): boolean {
  return options.kind === 'auto' && !session?.snapshot;
}

function missingSnapshotOverlayCheck(): DoctorCheck {
  return {
    id: 'rn-overlay',
    status: 'info',
    summary: 'No current session snapshot; React Native overlay check skipped.',
    command: 'agent-device snapshot -i',
  };
}

async function probeMetro(host: string, port: number, kind: DoctorKind): Promise<DoctorCheck> {
  const url = `http://${host}:${port}/status`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(METRO_PROBE_TIMEOUT_MS) });
    const text = await response.text();
    const running = response.ok && text.toLowerCase().includes('packager-status:running');
    return {
      id: 'metro',
      status: running ? 'pass' : 'warn',
      summary: running
        ? `Metro is reachable at ${url}.`
        : `Metro responded at ${url}, but did not report packager-status:running.`,
      hint: running
        ? undefined
        : 'Verify this is the Metro instance for the target app, or restart Metro.',
      evidence: { url, statusCode: response.status, body: text.slice(0, 120), kind },
    };
  } catch (error) {
    return {
      id: 'metro',
      status: kind === 'auto' ? 'warn' : 'fail',
      summary: `Metro is not reachable at ${url}.`,
      hint: 'Start Metro, pass the correct --metro-host/--metro-port, or use a remote Metro profile.',
      command: `curl -fsS ${url}`,
      evidence: { url, error: error instanceof Error ? error.message : String(error), kind },
    };
  }
}

function summarizeDoctorStatus(checks: DoctorCheck[]): 'pass' | 'warn' | 'fail' {
  if (checks.some((check) => check.status === 'fail')) return 'fail';
  if (checks.some((check) => check.status === 'warn')) return 'warn';
  return 'pass';
}

function doctorSummary(status: 'pass' | 'warn' | 'fail'): string {
  if (status === 'fail') return 'Blockers found before the run.';
  if (status === 'warn') return 'No hard blockers found, but warnings need attention.';
  return 'No blockers found.';
}

function sortChecks(checks: DoctorCheck[]): DoctorCheck[] {
  const order: Record<DoctorStatus, number> = { fail: 0, warn: 1, pass: 2, info: 3 };
  return [...checks].sort((a, b) => order[a.status] - order[b.status]);
}

function appendDoctorChecks(checks: DoctorCheck[], ...items: DoctorCheck[]): void {
  for (const check of items) {
    appendDoctorCheck(checks, check);
  }
}

function appendDoctorCheck(checks: DoctorCheck[], check: DoctorCheck): void {
  checks.push(check);
  emitRequestProgress({
    type: 'command',
    status: 'progress',
    message: formatDoctorProgressMessage(check),
  });
}

function formatDoctorProgressMessage(check: DoctorCheck): string {
  return [formatDoctorProgressSummary(check), ...formatDoctorProgressDetails(check)].join('\n');
}

function formatDoctorProgressSummary(check: DoctorCheck): string {
  return `${doctorProgressMarker(check.status)} ${check.id}: ${check.summary}`;
}

function formatDoctorProgressDetails(check: DoctorCheck): string[] {
  if (check.status !== 'fail' && check.status !== 'warn') return [];
  if (check.command) return [`  run: ${check.command}`];
  if (check.hint) return [`  hint: ${check.hint}`];
  return [];
}

function doctorProgressMarker(status: DoctorStatus): string {
  if (status === 'pass') return '✓';
  if (status === 'fail') return '⨯';
  if (status === 'warn') return '!';
  return '-';
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readPositivePort(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}
