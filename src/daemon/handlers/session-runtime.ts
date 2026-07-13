import { AppError, asAppError } from '../../kernel/errors.ts';
import { publicPlatformString, type DeviceInfo } from '../../kernel/device.ts';
import type { CommandFlags } from '../../core/dispatch.ts';
import type { DaemonRequest, SessionRuntimeHints, SessionState } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import {
  clearRuntimeHintsFromApp,
  hasRuntimeTransportHints,
  trimRuntimeValue,
} from '../runtime-hints.ts';
import { isAndroidEmulator, isIosSimulator } from '../device-targets.ts';
import { errorResponse, type DaemonFailureResponse } from './response.ts';

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
  if (value !== 'ios' && value !== 'android') {
    throw new AppError(
      'INVALID_ARGS',
      `Invalid open runtime platform: ${String(value)}. Use "ios" or "android".`,
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
  if (platform === 'ios' || platform === 'android') {
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
): SessionRuntimeHints | undefined {
  if (!runtime) return undefined;
  if (countConfiguredRuntimeHints(runtime) === 0) {
    sessionStore.clearRuntimeHints(sessionName);
    return undefined;
  }
  sessionStore.setRuntimeHints(sessionName, runtime);
  return runtime;
}

function resolveSessionRuntimeHints(
  sessionStore: SessionStore,
  sessionName: string,
  device?: DeviceInfo,
  platform?: RuntimePlatform,
): SessionRuntimeHints | undefined {
  const runtime = sessionStore.getRuntimeHints(sessionName);
  if (!runtime) return undefined;
  const boundPlatform = device ? publicPlatformString(device) : undefined;
  const deviceRuntimePlatform = toRuntimePlatform(boundPlatform) ?? platform;
  if (runtime.platform && device && !deviceRuntimePlatform) {
    throw new AppError(
      'INVALID_ARGS',
      `Session runtime hints are only supported on iOS and Android sessions, but session "${sessionName}" is bound to ${boundPlatform}.`,
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
  req: DaemonRequest;
  sessionStore: SessionStore;
  sessionName: string;
  device?: DeviceInfo;
  platform?: RuntimePlatform;
}): {
  runtime: SessionRuntimeHints | undefined;
  previousRuntime: SessionRuntimeHints | undefined;
  replacedStoredRuntime: boolean;
} {
  const { req, sessionStore, sessionName, device } = params;
  const runtimePlatform = device
    ? toRuntimePlatform(publicPlatformString(device))
    : params.platform;
  const previousRuntime = sessionStore.getRuntimeHints(sessionName);
  const explicitRuntime = normalizeExplicitRuntimeHints({
    runtime: req.runtime,
    sessionName,
    platform: runtimePlatform,
  });
  if (req.runtime === undefined) {
    const storedRuntime = resolveSessionRuntimeHints(
      sessionStore,
      sessionName,
      device,
      runtimePlatform,
    );
    return {
      runtime: device ? applyDeviceDefaultMetroHost(storedRuntime, device) : storedRuntime,
      previousRuntime,
      replacedStoredRuntime: false,
    };
  }
  const selectedRuntime =
    explicitRuntime && countConfiguredRuntimeHints(explicitRuntime) > 0
      ? explicitRuntime
      : undefined;
  return {
    runtime: device ? applyDeviceDefaultMetroHost(selectedRuntime, device) : selectedRuntime,
    previousRuntime,
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

export async function maybeClearRemovedRuntimeTransportHints(params: {
  replacedStoredRuntime: boolean;
  previousRuntime: SessionRuntimeHints | undefined;
  runtime: SessionRuntimeHints | undefined;
  session: SessionState | undefined;
}): Promise<void> {
  const { replacedStoredRuntime, previousRuntime, runtime, session } = params;
  if (
    !replacedStoredRuntime ||
    !session?.appBundleId ||
    !hasRuntimeTransportHints(previousRuntime) ||
    hasRuntimeTransportHints(runtime)
  ) {
    return;
  }
  await clearRuntimeHintsFromApp({
    device: session.device,
    appId: session.appBundleId,
  });
}
