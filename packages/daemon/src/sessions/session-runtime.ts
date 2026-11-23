import type { CommandFlags, DaemonWireRequest } from '@agent-device/contracts/command';
import {
  type OpenApplicationRuntimeHints,
  type RuntimeHintValues,
  type RuntimeHintsApplicationInput,
  hasRuntimeTransportHintValues,
} from '@agent-device/contracts/application-lifecycle-runtime';
import { AppError, asAppError, type ReasonTable } from '@agent-device/kernel/errors';
import {
  type DaemonFailureResponse,
  errorResponse,
  isSessionRuntimePlatform,
} from '@agent-device/kernel/contracts';
import { publicPlatformString, type DeviceInfo } from '@agent-device/kernel/device';
import type { SessionRuntimeHints, SessionState } from '../core/session-state.ts';
import { SessionStore, type StoredRuntimeHints } from '../core/session-store.ts';
import { trimRuntimeValue } from '@agent-device/host-kit/runtime-transport-hints';
import { isAndroidEmulator, isIosSimulator } from './device/device-targets.ts';

export const RUNTIME_HINTS_REASONS = {
  // Runtime hints were requested, but the device runtime admitted no operation to apply or clear
  // them.
  operationMissing: { reason: 'runtime-hints-operation-missing' },
} as const satisfies ReasonTable<'open'>;

type SessionRuntimeHintsStore = Readonly<{
  getRuntimeHints: SessionStore['getRuntimeHints'];
}>;

// Loopback aliases an emulator/simulator app uses to reach the dev server on the host machine.
const ANDROID_EMULATOR_LOOPBACK_HOST = '10.0.2.2';
const IOS_SIMULATOR_LOOPBACK_HOST = '127.0.0.1';

const RUNTIME_HINT_FIELD_NAMES = [
  'platform',
  'metroHost',
  'metroPort',
  'bundleUrl',
  'launchUrl',
] as const;
type RuntimePlatform = NonNullable<SessionRuntimeHints['platform']>;

export function countConfiguredRuntimeHints(runtime: SessionRuntimeHints | undefined): number {
  if (!runtime) return 0;
  return [runtime.metroHost, runtime.metroPort, runtime.bundleUrl, runtime.launchUrl].filter(
    (value) => value !== undefined && value !== '',
  ).length;
}

/** Converts daemon-owned runtime policy into the neutral key/value runtime-facet contract. */
export function runtimeHintValues(runtime: SessionRuntimeHints | undefined): RuntimeHintValues {
  if (!runtime) return {};
  const values: Record<string, string> = {};
  if (runtime.metroHost !== undefined) values.metroHost = runtime.metroHost;
  if (runtime.metroPort !== undefined) values.metroPort = String(runtime.metroPort);
  if (runtime.bundleUrl !== undefined) values.bundleUrl = runtime.bundleUrl;
  if (runtime.launchUrl !== undefined) values.launchUrl = runtime.launchUrl;
  return values;
}

export function hasRuntimeTransportHints(runtime: SessionRuntimeHints | undefined): boolean {
  return hasRuntimeTransportHintValues(runtimeHintValues(runtime));
}

/**
 * Pairs the open's requested transport hints with the fact-admitted apply operation, so the
 * lifecycle input cannot carry a hints request without its transport. Absent when the open
 * requests no transport hint. Transport hints without the admitted operation are a caller bug:
 * the builder refuses them here, before any dispatch, so `dispatched: 'no'` holds.
 */
export function openApplicationRuntimeHints(
  runtime: SessionRuntimeHints | undefined,
  apply: ((input: RuntimeHintsApplicationInput) => Promise<void>) | undefined,
): OpenApplicationRuntimeHints | undefined {
  if (!hasRuntimeTransportHints(runtime)) return undefined;
  if (apply === undefined) {
    throw new AppError(
      'COMMAND_FAILED',
      'Transport runtime hints were requested without the fact-admitted apply operation; pair the hints with the operation or drop them.',
      { reason: RUNTIME_HINTS_REASONS.operationMissing.reason, dispatched: 'no' },
    );
  }
  return { values: runtimeHintValues(runtime), apply };
}

function normalizeRuntimeStringInput(
  value: unknown,
  fieldName: 'metroHost' | 'bundleUrl' | 'launchUrl',
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new AppError('INVALID_ARGS', `Invalid open runtime ${fieldName}: expected string.`);
  }
  return trimRuntimeValue(value);
}

function validateRuntimePort(port: number | undefined): number | undefined {
  if (port === undefined) return undefined;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError(
      'INVALID_ARGS',
      `Invalid runtime metroPort: ${String(port)}. Use an integer between 1 and 65535.`,
    );
  }
  return port;
}

function normalizeRuntimePortInput(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number') {
    throw new AppError('INVALID_ARGS', 'Invalid open runtime metroPort: expected integer.');
  }
  return validateRuntimePort(value);
}

function normalizeRuntimePlatformInput(
  value: unknown,
  sessionName: string,
  platform?: RuntimePlatform,
): RuntimePlatform | undefined {
  if (value === undefined) return platform;
  if (!isSessionRuntimePlatform(value)) {
    throw new AppError(
      'INVALID_ARGS',
      `Invalid open runtime platform: ${String(value)}. Use "ios", "android", or "harmonyos".`,
    );
  }
  if (platform && value !== platform) {
    throw new AppError(
      'INVALID_ARGS',
      `open runtime targets ${value}, but session "${sessionName}" is bound to ${platform}.`,
    );
  }
  return value;
}

export function toRuntimePlatform(
  platform: CommandFlags['platform'] | DeviceInfo['platform'] | 'apple' | undefined,
): RuntimePlatform | undefined {
  if (isSessionRuntimePlatform(platform)) {
    return platform;
  }
  return undefined;
}

export function buildRuntimeHints(
  flags: CommandFlags | undefined,
  platform?: RuntimePlatform,
): SessionRuntimeHints {
  return {
    platform,
    metroHost: trimRuntimeValue(flags?.metroHost),
    metroPort: validateRuntimePort(flags?.metroPort),
    bundleUrl: trimRuntimeValue(flags?.bundleUrl),
    launchUrl: trimRuntimeValue(flags?.launchUrl),
  };
}

export function mergeRuntimeHints(
  current: SessionRuntimeHints | undefined,
  next: SessionRuntimeHints,
): SessionRuntimeHints {
  return {
    platform: next.platform ?? current?.platform,
    metroHost: next.metroHost ?? current?.metroHost,
    metroPort: next.metroPort ?? current?.metroPort,
    bundleUrl: next.bundleUrl ?? current?.bundleUrl,
    launchUrl: next.launchUrl ?? current?.launchUrl,
  };
}

function defaultMetroHostForDevice(device: DeviceInfo): string | undefined {
  if (isAndroidEmulator(device)) return ANDROID_EMULATOR_LOOPBACK_HOST;
  if (isIosSimulator(device)) return IOS_SIMULATOR_LOOPBACK_HOST;
  return undefined;
}

// A port-only hint (`--metro-port` without `--metro-host`) otherwise writes no dev-server pref.
// Emulator/simulator hosts are unambiguous, so fill in the loopback alias; physical devices stay
// ambiguous and still require an explicit `--metro-host`.
export function applyDeviceDefaultMetroHost(
  runtime: SessionRuntimeHints | undefined,
  device: DeviceInfo,
): SessionRuntimeHints | undefined {
  if (!runtime) return runtime;
  if (trimRuntimeValue(runtime.metroHost)) return runtime;
  if (trimRuntimeValue(runtime.bundleUrl)) return runtime; // bundleUrl carries its own host
  if (runtime.metroPort === undefined) return runtime;
  const host = defaultMetroHostForDevice(device);
  if (!host) return runtime;
  return { ...runtime, metroHost: host };
}

function normalizeExplicitRuntimeHints(params: {
  runtime: unknown;
  sessionName: string;
  platform?: RuntimePlatform;
}): SessionRuntimeHints | undefined {
  const { runtime, sessionName, platform } = params;
  if (runtime === undefined) return undefined;
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
    throw new AppError('INVALID_ARGS', 'open runtime must be an object.');
  }
  const runtimeRecord = runtime as Record<string, unknown>;
  const unknownField = Object.keys(runtimeRecord).find(
    (fieldName) =>
      !RUNTIME_HINT_FIELD_NAMES.includes(fieldName as (typeof RUNTIME_HINT_FIELD_NAMES)[number]),
  );
  if (unknownField) {
    throw new AppError(
      'INVALID_ARGS',
      `Invalid open runtime field: ${unknownField}. Supported fields are ${RUNTIME_HINT_FIELD_NAMES.join(', ')}.`,
    );
  }
  return {
    platform: normalizeRuntimePlatformInput(runtimeRecord.platform, sessionName, platform),
    metroHost: normalizeRuntimeStringInput(runtimeRecord.metroHost, 'metroHost'),
    metroPort: normalizeRuntimePortInput(runtimeRecord.metroPort),
    bundleUrl: normalizeRuntimeStringInput(runtimeRecord.bundleUrl, 'bundleUrl'),
    launchUrl: normalizeRuntimeStringInput(runtimeRecord.launchUrl, 'launchUrl'),
  };
}

export function setSessionRuntimeHintsForOpen(
  sessionStore: SessionStore,
  sessionName: string,
  runtime: SessionRuntimeHints | undefined,
  appId: string | undefined,
): SessionRuntimeHints | undefined {
  if (!runtime) return undefined;
  if (countConfiguredRuntimeHints(runtime) === 0) {
    sessionStore.setRuntimeHints(sessionName, undefined);
    return undefined;
  }
  sessionStore.setRuntimeHints(sessionName, runtime, appId);
  return runtime;
}

/** Binds stored hints that an open applied to the app it opened. */
export function bindStoredRuntimeHintsToApp(
  sessionStore: SessionStore,
  sessionName: string,
  appId: string | undefined,
): void {
  const stored = sessionStore.getRuntimeHints(sessionName);
  if (stored && appId) sessionStore.setRuntimeHints(sessionName, stored.hints, appId);
}

/** Stored hints apply to the app they are bound to, or to any app while they are unbound. */
export function storedRuntimeHintsForApp(
  runtime: SessionRuntimeHints | undefined,
  boundAppId: string | undefined,
  appId: string | undefined,
): SessionRuntimeHints | undefined {
  return boundAppId === undefined || boundAppId === appId ? runtime : undefined;
}

function resolveSessionRuntimeHints(
  runtime: SessionRuntimeHints | undefined,
  sessionName: string,
  device?: DeviceInfo,
  platform?: RuntimePlatform,
): SessionRuntimeHints | undefined {
  if (!runtime) return undefined;
  const boundPlatform = device ? publicPlatformString(device) : undefined;
  const deviceRuntimePlatform = toRuntimePlatform(boundPlatform) ?? platform;
  if (runtime.platform && device && !deviceRuntimePlatform) {
    throw new AppError(
      'INVALID_ARGS',
      `Session runtime hints are only supported on iOS, Android, and HarmonyOS sessions, but session "${sessionName}" is bound to ${boundPlatform}.`,
    );
  }
  if (runtime.platform && deviceRuntimePlatform && runtime.platform !== deviceRuntimePlatform) {
    throw new AppError(
      'INVALID_ARGS',
      `Session runtime hints target ${runtime.platform}, but session "${sessionName}" is bound to ${boundPlatform}. Clear the runtime hints or use a different session.`,
    );
  }
  if (deviceRuntimePlatform && runtime.platform !== deviceRuntimePlatform) {
    return { ...runtime, platform: deviceRuntimePlatform };
  }
  return runtime;
}

function resolveOpenRuntimeHints(params: {
  req: DaemonWireRequest;
  sessionStore: SessionRuntimeHintsStore;
  sessionName: string;
  device?: DeviceInfo;
  platform?: RuntimePlatform;
}): {
  runtime: SessionRuntimeHints | undefined;
  previous: StoredRuntimeHints | undefined;
  replacedStoredRuntime: boolean;
} {
  const { req, sessionStore, sessionName, device } = params;
  const runtimePlatform = device
    ? toRuntimePlatform(publicPlatformString(device))
    : params.platform;
  const previous = sessionStore.getRuntimeHints(sessionName);
  const explicitRuntime = normalizeExplicitRuntimeHints({
    runtime: req.runtime,
    sessionName,
    platform: runtimePlatform,
  });
  if (req.runtime === undefined) {
    const storedRuntime = resolveSessionRuntimeHints(
      previous?.hints,
      sessionName,
      device,
      runtimePlatform,
    );
    return {
      runtime: device ? applyDeviceDefaultMetroHost(storedRuntime, device) : storedRuntime,
      previous,
      replacedStoredRuntime: false,
    };
  }
  const selectedRuntime =
    explicitRuntime && countConfiguredRuntimeHints(explicitRuntime) > 0
      ? explicitRuntime
      : undefined;
  return {
    runtime: device ? applyDeviceDefaultMetroHost(selectedRuntime, device) : selectedRuntime,
    previous,
    replacedStoredRuntime: true,
  };
}

export function resolveEffectiveOpenRuntimeHints(
  params: Parameters<typeof resolveOpenRuntimeHints>[0],
): SessionRuntimeHints | undefined {
  return resolveOpenRuntimeHints(params).runtime;
}

export function tryResolveOpenRuntimeHints(
  params: Parameters<typeof resolveOpenRuntimeHints>[0],
): { ok: true; data: ReturnType<typeof resolveOpenRuntimeHints> } | DaemonFailureResponse {
  try {
    return {
      ok: true,
      data: resolveOpenRuntimeHints(params),
    };
  } catch (error) {
    const appErr = asAppError(error);
    return errorResponse(appErr.code, appErr.message, appErr.details);
  }
}

type RemovedRuntimeHintsPolicyInput = Readonly<{
  replacedStoredRuntime: boolean;
  previous: StoredRuntimeHints | undefined;
  runtime: SessionRuntimeHints | undefined;
  session: SessionState | undefined;
}>;

/**
 * Whether an open may have to remove the native transport of the stored hints it replaces.
 * Admission runs before the open resolves its app, so new transport hints admit the clear whenever
 * the replaced hints are bound to an app.
 */
export function mayClearRemovedRuntimeTransportHints(
  params: RemovedRuntimeHintsPolicyInput,
): boolean {
  return (
    params.replacedStoredRuntime &&
    requiresRuntimeHintsClear(removedRuntimeHintsClearInput(params)) &&
    (!hasRuntimeTransportHints(params.runtime) || params.previous?.appId !== undefined)
  );
}

/** New transport hints overwrite the replaced ones on their bound app; another app is cleared. */
export async function maybeClearRemovedRuntimeTransportHints(
  params: RemovedRuntimeHintsPolicyInput &
    Readonly<{
      /** The app this open resolved for its target. */
      appId: string | undefined;
      clearRuntimeHints(input: RuntimeHintsApplicationInput): Promise<void>;
    }>,
): Promise<void> {
  if (!mayClearRemovedRuntimeTransportHints(params)) return;
  if (hasRuntimeTransportHints(params.runtime) && params.previous?.appId === params.appId) return;
  await params.clearRuntimeHints(removedRuntimeHintsClearInput(params));
}

function removedRuntimeHintsClearInput(
  params: Pick<RemovedRuntimeHintsPolicyInput, 'previous' | 'session'>,
): RuntimeHintsApplicationInput {
  return runtimeHintsClearInput(params.previous, params.session?.appBundleId);
}

/** Clearing stored hints targets the app they are bound to, else the session's current app. */
export function runtimeHintsClearInput(
  stored: StoredRuntimeHints | undefined,
  sessionAppId: string | undefined,
): RuntimeHintsApplicationInput {
  return { appId: stored?.appId ?? sessionAppId, values: runtimeHintValues(stored?.hints) };
}

export function requiresRuntimeHintsClear(input: RuntimeHintsApplicationInput): boolean {
  return Boolean(input.appId) && hasRuntimeTransportHintValues(input.values);
}
