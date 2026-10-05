import { normalizeBatchCommandName } from '@agent-device/command-registry/batch-policy';
import type { DeviceLease } from '@agent-device/contracts/device';
import { readMacOsAppBackend } from '@agent-device/contracts/session';
import { runCmd } from '@agent-device/host-kit/command';
import { isProcessAlive, readHostEnvironmentVariable } from '@agent-device/host-kit/process';
import { isMacOs } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { DaemonRequest } from './daemon-request.ts';
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
 * The commands a `macos-app` lease admits. Every other command, including any added later, is
 * refused: an allow list fails closed the way a daemon policy allow list does (ADR 0029).
 */
const MACOS_APP_LEASE_COMMANDS: ReadonlySet<string> = new Set([
  'open',
  'close',
  'snapshot',
  'wait',
  'find',
  'get',
  'is',
  'click',
  'fill',
  'press',
  'type',
  'focus',
  'scroll',
  'screenshot',
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
  | 'backend'
  | 'process';

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

/** The only screenshot path a remote client sends: the temp file `agent-device` names for it. */
const REMOTE_SCREENSHOT_PATH = /^\/tmp\/agent-device-screenshot-[0-9]+-[a-z0-9]+\.png$/;

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
  assertInvocation(key, req.command, req.positionals ?? [], {
    ...req.input,
    ...req.flags,
    ...(req.runtime?.launchUrl ? { launchUrl: req.runtime.launchUrl } : {}),
    ...(req.runtime?.bundleUrl ? { bundleUrl: req.runtime.bundleUrl } : {}),
  });
  if (req.command === 'batch') {
    for (const step of (req.flags?.batchSteps ?? []) as readonly Record<string, unknown>[]) {
      const positionals = Array.isArray(step.positionals) ? step.positionals.map(String) : [];
      assertInvocation(key, normalizeBatchCommandName(step.command), positionals, {
        ...(step.input as Record<string, unknown> | undefined),
        ...(step.flags as Record<string, unknown> | undefined),
      });
    }
  }
  if (session) assertSessionIsLeasedApp(key, session);
}

function assertInvocation(
  key: MacOsAppLeaseKey,
  command: string,
  positionals: readonly string[],
  fields: Readonly<Record<string, unknown>>,
): void {
  if (!MACOS_APP_LEASE_COMMANDS.has(command)) {
    throw macOsAppLeaseDenied('command', `A macos-app lease does not allow ${command}.`, {
      command,
    });
  }
  assertAppSurface(fields);
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
    if (target === undefined || (typeof target === 'string' && REMOTE_SCREENSHOT_PATH.test(target)))
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
