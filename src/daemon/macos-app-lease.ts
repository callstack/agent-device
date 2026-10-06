import os from 'node:os';
import { normalizeBatchCommandName } from '@agent-device/command-registry/batch-policy';
import type { DeviceLease } from '@agent-device/contracts/device';
import { readMacOsAppBackend } from '@agent-device/contracts/session';
import { runCmd } from '@agent-device/host-kit/command';
import { isProcessAlive, readHostEnvironmentVariable } from '@agent-device/host-kit/process';
import { isMacOs } from '@agent-device/kernel/device';
import { AppError, type DaemonError } from '@agent-device/kernel/errors';
import { isAppLeaseAllowed } from './daemon-command-registry.ts';
import { isRemoteTempArtifactPath } from '../remote/daemon-artifacts.ts';
import type { DaemonRequest, DaemonResponse, DaemonResponseData } from './daemon-request.ts';
import type { LeaseRegistry } from './lease-registry.ts';
import type { SessionState } from './session-state.ts';

/**
 * A `macos-app` lease rents one app on the host Mac, never the desktop. Its device key is the app's
 * bundle id, optionally pinned to one process: `<bundleId>` or `<bundleId>@<pid>`.
 */
export type MacOsAppLeaseKey = Readonly<{ bundleId: string; pid?: number }>;

const BUNDLE_ID = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/;
const PID = /^[1-9][0-9]{0,9}$/;

export function parseMacOsAppLeaseKey(deviceKey: string | undefined): MacOsAppLeaseKey {
  const value = deviceKey?.trim() ?? '';
  const at = value.lastIndexOf('@');
  const bundleId = at < 0 ? value : value.slice(0, at);
  const pidText = at < 0 ? undefined : value.slice(at + 1);
  if (!BUNDLE_ID.test(bundleId) || (pidText !== undefined && !PID.test(pidText))) {
    throw new AppError(
      'INVALID_ARGS',
      'A macos-app lease device key must be <bundleId> or <bundleId>@<pid>.',
      { deviceKey: value },
    );
  }
  return pidText === undefined ? { bundleId } : { bundleId, pid: Number(pidText) };
}

/**
 * The requests that run without the leased app's session: `open` creates it, each `batch` step is
 * admitted again when it runs, and a heartbeat acts on the lease alone, and a release is refused (the host ends the lease).
 */
const SESSIONLESS_COMMANDS: ReadonlySet<string> = new Set([
  'open',
  'batch',
  'lease_heartbeat',
  'lease_release',
]);

type MacOsAppLeaseRule =
  | 'command'
  | 'app'
  | 'surface'
  | 'capture'
  | 'host-path'
  | 'device'
  | 'backend'
  | 'process'
  | 'session'
  | 'diagnostics';

/**
 * Inputs that name a path on the daemon host or launch something beside the app. A client of a
 * remote daemon cannot see the host's disk, so none of these has a use under the lease.
 */
const HOST_INPUT_KEYS = [
  'out',
  'saveScript',
  'sessionSaveScript',
  'baseline',
  'launchConsole',
  'launchArgs',
  'launchUrl',
  'bundleUrl',
  'artifactsDir',
  'stepsFile',
  'searchPath',
  'retainPaths',
  'installSource',
  'metroProjectRoot',
  'metroRuntimeFile',
  'iosXctestrunFile',
  'iosXctestDerivedDataPath',
  'iosXctestEnvDir',
] as const;

/** Flags that pick a device other than the leased app's own; a lease never takes a device selector. */
const DEVICE_SELECTOR_KEYS = [
  'device',
  'udid',
  'serial',
  'target',
  'iosSimulatorDeviceSet',
  'androidDeviceAllowlist',
] as const;

function macOsAppLeaseDenied(
  rule: MacOsAppLeaseRule,
  message: string,
  details: Record<string, unknown> = {},
): AppError {
  return new AppError('UNAUTHORIZED', message, {
    ...details,
    reason: 'MACOS_APP_LEASE_DENIED',
    rule,
    retriable: false,
    hint: 'This lease is limited to one macOS app; retrying will not help. Use an allowed command on the leased app.',
  });
}

/**
 * Refuses a request a `macos-app` lease does not cover. Batch steps and replay actions re-enter
 * request admission, so each is checked again when it runs; a batch is also checked whole first so
 * no step runs before a later one is refused.
 */
export function assertMacOsAppLeaseAdmitsRequest(
  lease: Pick<DeviceLease, 'backend' | 'deviceKey'>,
  req: Pick<DaemonRequest, 'command' | 'positionals' | 'flags' | 'input' | 'runtime'>,
  session?: Pick<SessionState, 'device' | 'surface' | 'appBundleId'>,
): void {
  if (lease.backend !== 'macos-app') return;
  const key = parseMacOsAppLeaseKey(lease.deviceKey);
  assertInvocation(
    key,
    req.command,
    req.positionals ?? [],
    withRuntimeInputs(req.runtime, { ...req.input, ...req.flags }),
  );
  if ((req.command === 'open' || req.command === 'batch') && req.flags?.platform !== 'macos') {
    throw macOsAppLeaseDenied(
      'device',
      `A macos-app lease needs platform macos on ${req.command}.`,
    );
  }
  if (req.command === 'batch') {
    for (const step of (req.flags?.batchSteps ?? []) as readonly Record<string, unknown>[]) {
      const positionals = Array.isArray(step.positionals) ? step.positionals.map(String) : [];
      assertInvocation(
        key,
        normalizeBatchCommandName(step.command),
        positionals,
        withRuntimeInputs(step.runtime as DaemonRequest['runtime'], {
          ...(step.input as Record<string, unknown> | undefined),
          ...(step.flags as Record<string, unknown> | undefined),
        }),
      );
    }
  }
  if (session) assertSessionIsLeasedApp(key, session);
  else if (!SESSIONLESS_COMMANDS.has(req.command)) {
    throw macOsAppLeaseDenied(
      'session',
      `A macos-app lease runs ${req.command} only in a session of ${key.bundleId}; open it first.`,
      { command: req.command, bundleId: key.bundleId },
    );
  }
}

function withRuntimeInputs(
  runtime: DaemonRequest['runtime'],
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...fields,
    ...(runtime?.launchUrl ? { launchUrl: runtime.launchUrl } : {}),
    ...(runtime?.bundleUrl ? { bundleUrl: runtime.bundleUrl } : {}),
  };
}

function assertInvocation(
  key: MacOsAppLeaseKey,
  command: string,
  positionals: readonly string[],
  fields: Readonly<Record<string, unknown>>,
): void {
  if (!isAppLeaseAllowed(command)) {
    throw macOsAppLeaseDenied('command', `A macos-app lease does not allow ${command}.`, {
      command,
    });
  }
  assertAppSurface(fields);
  assertNoDeviceSelector(fields);
  if (command === 'screenshot') assertWindowCapture(positionals, fields);
  else assertNoHostInputs(fields);
  if (command === 'open') assertOpensLeasedApp(key, positionals);
  if (command === 'close' && positionals.length > 0 && positionals[0] !== key.bundleId) {
    throw macOsAppLeaseDenied('app', `A macos-app lease only closes ${key.bundleId}.`, {
      bundleId: key.bundleId,
    });
  }
}

function assertWindowCapture(
  positionals: readonly string[],
  fields: Readonly<Record<string, unknown>>,
): void {
  if (fields.screenshotFullscreen === true) {
    throw macOsAppLeaseDenied('capture', 'A macos-app lease captures only the app window.');
  }
  const { out, ...rest } = fields;
  assertNoHostInputs(rest);
  for (const target of [positionals[0], out]) {
    if (
      target === undefined ||
      (typeof target === 'string' && isRemoteTempArtifactPath(target, 'screenshot', '.png'))
    )
      continue;
    throw macOsAppLeaseDenied('host-path', 'A macos-app lease does not write files on the host.');
  }
}

function assertNoHostInputs(fields: Readonly<Record<string, unknown>>): void {
  const named = HOST_INPUT_KEYS.find((key) => fields[key] !== undefined && fields[key] !== false);
  if (!named) return;
  throw macOsAppLeaseDenied(
    'host-path',
    `A macos-app lease does not accept ${named}, which names a host path or launch.`,
    { field: named },
  );
}

function assertNoDeviceSelector(fields: Readonly<Record<string, unknown>>): void {
  const named = DEVICE_SELECTOR_KEYS.find((key) => fields[key] !== undefined && fields[key] !== '');
  if (!named) return;
  throw macOsAppLeaseDenied(
    'device',
    `A macos-app lease does not accept the ${named} device selector.`,
    {
      field: named,
    },
  );
}

function assertAppSurface(fields: Readonly<Record<string, unknown>>): void {
  if (fields.surface !== undefined && fields.surface !== 'app') {
    throw macOsAppLeaseDenied(
      'surface',
      `A macos-app lease is limited to the app surface, not ${String(fields.surface)}.`,
      { surface: fields.surface },
    );
  }
  if (fields.platform !== undefined && fields.platform !== 'macos') {
    throw macOsAppLeaseDenied('app', 'A macos-app lease only drives a macOS app.', {
      platform: fields.platform,
    });
  }
}

function assertOpensLeasedApp(key: MacOsAppLeaseKey, positionals: readonly string[]): void {
  if (positionals.length !== 1 || positionals[0] !== key.bundleId) {
    throw macOsAppLeaseDenied('app', `A macos-app lease only opens ${key.bundleId}.`, {
      bundleId: key.bundleId,
    });
  }
  assertNativeBackend();
}

/**
 * The XCTest backend posts screen events at points measured from the app's origin, so a point
 * outside the app's window lands on whatever is there. Only the native backend (ADR 0031) resolves
 * every action inside the session app.
 */
function assertNativeBackend(): void {
  if (readMacOsAppBackend(readHostEnvironmentVariable) === 'native') return;
  throw macOsAppLeaseDenied(
    'backend',
    'A macos-app lease needs the native macOS app backend (AGENT_DEVICE_MACOS_APP_BACKEND=native).',
  );
}

function assertSessionIsLeasedApp(
  key: MacOsAppLeaseKey,
  session: Pick<SessionState, 'device' | 'surface' | 'appBundleId'>,
): void {
  if (
    !isMacOs(session.device) ||
    (session.surface ?? 'app') !== 'app' ||
    session.appBundleId !== key.bundleId
  ) {
    throw macOsAppLeaseDenied('app', `This session is not the leased app ${key.bundleId}.`, {
      bundleId: key.bundleId,
    });
  }
}

/** The bundle id of the app running as `pid`, or undefined when no app runs as that pid. */
export type MacOsRunningAppReader = (pid: number) => Promise<string | undefined>;

const LSAPPINFO_BUNDLE_ID = /bundleID="([^"]+)"/;

const readRunningAppBundleId: MacOsRunningAppReader = async (pid) => {
  if (!isProcessAlive(pid)) return undefined;
  const result = await runCmd('/usr/bin/lsappinfo', ['info', '-only', 'bundleid', String(pid)], {
    allowFailure: true,
    timeoutMs: 5_000,
  });
  return LSAPPINFO_BUNDLE_ID.exec(result.stdout)?.[1];
};

/**
 * A pid-pinned lease is usable only while that process runs the leased bundle. A bundle-only key
 * follows whichever process of the bundle is running, so it has nothing to check here.
 */
export async function assertMacOsAppLeaseProcess(
  lease: Pick<DeviceLease, 'backend' | 'deviceKey'>,
  readBundleId: MacOsRunningAppReader = readRunningAppBundleId,
): Promise<void> {
  if (lease.backend !== 'macos-app') return;
  const key = parseMacOsAppLeaseKey(lease.deviceKey);
  if (key.pid === undefined) return;
  if ((await readBundleId(key.pid)) === key.bundleId) return;
  throw macOsAppLeaseDenied(
    'process',
    `The leased app process ${key.bundleId}@${key.pid} is no longer running.`,
    { bundleId: key.bundleId, pid: key.pid },
  );
}

/**
 * What `open` reports about the host that runs the app: the session state paths and the device the
 * session is bound to, whose name is the host's own. A tenant needs none of them.
 */
const HOST_OPEN_RESULT_KEYS = [
  'sessionStateDir',
  'runnerLogPath',
  'requestLogPath',
  'eventLogPath',
  'device',
  'id',
  'kind',
  'serial',
  'device_udid',
  'ios_simulator_device_set',
] as const;

const HOST_PATH =
  /(?<![\p{L}\p{N}_./])\/(?:Users|home|private|var|tmp|Volumes|Library|Applications|opt|System|usr|etc|Network|cores)(?:\/[\p{L}\p{N}_.@%+~-]+)*\/?/gu;
const MIN_HOST_NAME_LENGTH = 4;

export type MacOsAppLeaseHost = Readonly<{ hostName: string; homeDirectory: string }>;

function readHost(): MacOsAppLeaseHost {
  return { hostName: os.hostname(), homeDirectory: os.homedir() };
}

/**
 * Shapes a response for a tenant under a `macos-app` lease so it names nothing about the host
 * beyond the leased app: `open` drops the session paths and the device and redacts its warnings and
 * initial snapshot failure, any success drops the fallback screenshot path (the artifact handle
 * carries the file), and a failure drops its log locators and has every host path, the home
 * directory and the host name replaced in its text. Other success data is the app's own content and
 * passes through.
 */
export function redactMacOsAppLeaseResponse(
  command: string,
  response: DaemonResponse,
  host: MacOsAppLeaseHost = readHost(),
): DaemonResponse {
  if (response.ok) return { ok: true, data: redactSuccessData(command, response.data, host) };
  return { ok: false, error: redactError(response.error, host) };
}

function redactSuccessData(
  command: string,
  data: DaemonResponseData | undefined,
  host: MacOsAppLeaseHost,
): DaemonResponseData | undefined {
  if (!data) return data;
  const { fallbackScreenshotPath: _fallback, ...rest } = data;
  if (command !== 'open') return rest;
  for (const key of HOST_OPEN_RESULT_KEYS) delete rest[key];
  const { snapshot, initialSnapshotError, warnings, ...open } = rest;
  return {
    ...open,
    ...(snapshot === undefined
      ? {}
      : { snapshot: redactSuccessData('snapshot', snapshot as DaemonResponseData, host) }),
    ...(initialSnapshotError === undefined
      ? {}
      : { initialSnapshotError: redactError(initialSnapshotError as DaemonError, host) }),
    ...(warnings === undefined ? {} : { warnings: redactHostText(warnings, host) }),
  };
}

function redactError(error: DaemonError, host: MacOsAppLeaseHost): DaemonError {
  const { logPath: _logPath, diagnosticsRecord: _diagnosticsRecord, ...rest } = error;
  return redactHostText(rest, host);
}

function redactHostText<T>(value: T, host: MacOsAppLeaseHost): T {
  if (typeof value === 'string') return redactHostString(value, host) as T;
  if (Array.isArray(value)) return value.map((item) => redactHostText(item, host)) as T;
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactHostText(item, host)]),
  ) as T;
}

function redactHostString(text: string, host: MacOsAppLeaseHost): string {
  let redacted = text;
  if (host.homeDirectory.length > 1) {
    const home = host.homeDirectory.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    redacted = redacted.replaceAll(new RegExp(`${home}[\\w.@%+~/-]*`, 'g'), '<host-path>');
  }
  for (const name of new Set([host.hostName, host.hostName.split('.')[0]!])) {
    if (name.length >= MIN_HOST_NAME_LENGTH) redacted = redacted.replaceAll(name, '<host>');
  }
  return redacted.replace(HOST_PATH, '<host-path>');
}

/**
 * A request's diagnostics record is the host's own log, which names the host's paths throughout, so
 * a tenant that held a `macos-app` lease is not served one, even after the lease ended.
 */
export function assertMacOsAppLeaseTenantMayReadDiagnostics(
  registry: LeaseRegistry,
  tenantId: string | undefined,
): void {
  if (tenantId === undefined || !registry.hasHeldMacOsAppLease(tenantId)) return;
  throw macOsAppLeaseDenied('diagnostics', 'A macos-app lease does not serve request diagnostics.');
}
