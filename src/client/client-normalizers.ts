import type {
  AgentDeviceDevice,
  AgentDeviceSession,
  AgentDeviceSessionDevice,
  AppDeployResult,
  AppInstallFromSourceResult,
  InternalRequestOptions,
  MaterializationReleaseResult,
  StartupPerfSample,
} from '@agent-device/contracts/client';
import type { TargetShutdownResult } from '@agent-device/contracts/device';
import {
  isAppleOs,
  isApplePlatform,
  isPublicPlatform,
  isSerialAddressablePlatform,
  type AppleOS,
} from '@agent-device/kernel/device';
import { AppError, type DaemonError } from '@agent-device/kernel/errors';
import { sanitizeErrorCause } from '@agent-device/kernel/redaction';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { leaseScopeFromOptions, leaseScopeToRequestMeta } from '../core/lease-scope.ts';
import type { DaemonRequest, SessionRuntimeHints } from '../daemon/types.ts';
import {
  asRecord,
  isRecord,
  readDeviceTarget,
  readNullableString,
  readOptionalString,
  readRequiredDeviceKind,
  readRequiredNumber,
  readRequiredPlatform,
  readRequiredString,
  stripUndefined,
} from '../utils/parsing.ts';
import { buildAppIdentifiers, buildDeviceIdentifiers } from '../utils/result-serialization.ts';

export { readOptionalString, readRequiredString } from '../utils/parsing.ts';

const DEFAULT_SESSION_NAME = 'default';

export function normalizeDeployResult(
  data: Record<string, unknown>,
  session?: string,
): AppDeployResult {
  const bundleId = readOptionalString(data, 'bundleId');
  const pkg = readOptionalString(data, 'package');
  return {
    app: readRequiredString(data, 'app'),
    appPath: readRequiredString(data, 'appPath'),
    platform: readRequiredPlatform(data, 'platform'),
    appId: bundleId ?? pkg,
    bundleId,
    package: pkg,
    identifiers: buildAppIdentifiers({ session, bundleId, packageName: pkg }),
  };
}

export function normalizeInstallFromSourceResult(
  data: Record<string, unknown>,
  session?: string,
): AppInstallFromSourceResult {
  const bundleId = readOptionalString(data, 'bundleId');
  const packageName = readOptionalString(data, 'packageName');
  const appId = bundleId ?? packageName ?? readOptionalString(data, 'appId');
  const launchTarget = readOptionalString(data, 'launchTarget') ?? packageName ?? bundleId ?? appId;
  if (!launchTarget) {
    throw new AppError('COMMAND_FAILED', 'Daemon response is missing "launchTarget".', {
      response: data,
    });
  }
  return {
    appName: readOptionalString(data, 'appName'),
    appId,
    bundleId,
    packageName,
    launchTarget,
    installablePath: readOptionalString(data, 'installablePath'),
    archivePath: readOptionalString(data, 'archivePath'),
    materializationId: readOptionalString(data, 'materializationId'),
    materializationExpiresAt: readOptionalString(data, 'materializationExpiresAt'),
    identifiers: buildAppIdentifiers({ session, bundleId, packageName, appId }),
  };
}

export function normalizeMaterializationReleaseResult(
  data: Record<string, unknown>,
): MaterializationReleaseResult {
  return {
    released: data.released === true,
    materializationId: readRequiredString(data, 'materializationId'),
    identifiers: {},
  };
}

export function normalizeDevice(value: unknown): AgentDeviceDevice {
  const { record, platform, id, name, target } = readClientDeviceIdentity(value, 'name');
  const appleOs = readAppleOs(record);
  return {
    platform,
    target,
    kind: readRequiredDeviceKind(record, 'kind'),
    id,
    name,
    booted: typeof record.booted === 'boolean' ? record.booted : undefined,
    // Additive Apple-OS discriminant; Apple platforms only — gate on the platform so
    // a non-Apple record with a stray appleOs value is not preserved.
    ...(isApplePlatform(platform) && appleOs ? { appleOs } : {}),
    identifiers: buildDeviceIdentifiers(platform, id, name),
    ...buildClientDevicePlatformFields(platform, id),
  };
}

export function normalizeSession(value: unknown): AgentDeviceSession {
  const { record, platform, id, name, target } = readClientDeviceIdentity(value, 'name');
  const deviceName = readRequiredString(record, 'device');
  const appleOs = readAppleOs(record);
  const identifiers = {
    session: name,
    ...buildDeviceIdentifiers(platform, id, deviceName),
  };
  return {
    name,
    createdAt: readRequiredNumber(record, 'createdAt'),
    sessionStateDir: readOptionalString(record, 'sessionStateDir'),
    runnerLogPath: readOptionalString(record, 'runnerLogPath'),
    device: {
      platform,
      target,
      id,
      name: deviceName,
      // Additive Apple-OS discriminant; present only when the daemon emits it (Apple devices).
      ...(appleOs ? { appleOs } : {}),
      identifiers,
      ...buildClientDevicePlatformFields(platform, id, {
        simulatorSetPath: readNullableString(record, 'ios_simulator_device_set'),
      }),
    },
    identifiers,
  };
}

function readAppleOs(record: Record<string, unknown>): AppleOS | undefined {
  const value = record.appleOs;
  return isAppleOs(value) ? value : undefined;
}

function readClientDeviceIdentity(value: unknown, nameField: string) {
  const record = asRecord(value);
  return {
    record,
    platform: readRequiredPlatform(record, 'platform'),
    id: readRequiredString(record, 'id'),
    name: readRequiredString(record, nameField),
    target: readDeviceTarget(record, 'target'),
  };
}

function buildClientDevicePlatformFields(
  platform: AgentDeviceDevice['platform'],
  id: string,
  options: { simulatorSetPath?: string | null; serial?: string } = {},
): Pick<AgentDeviceSessionDevice, 'ios' | 'android' | 'harmonyos' | 'vega'> {
  if (platform === 'ios') {
    return {
      ios: {
        udid: id,
        ...(options.simulatorSetPath !== undefined
          ? { simulatorSetPath: options.simulatorSetPath }
          : {}),
      },
    };
  }
  if (!isSerialAddressablePlatform(platform)) return {};
  const serial = options.serial ?? id;
  if (platform === 'android') return { android: { serial } };
  if (platform === 'harmonyos') return { harmonyos: { serial } };
  return { vega: { serial } };
}

export function normalizeRuntimeHints(value: unknown): SessionRuntimeHints | undefined {
  if (!isRecord(value)) return undefined;
  const platform = value.platform;
  const metroHost = readOptionalString(value, 'metroHost');
  const metroPort = typeof value.metroPort === 'number' ? value.metroPort : undefined;
  const bundleUrl = readOptionalString(value, 'bundleUrl');
  const launchUrl = readOptionalString(value, 'launchUrl');
  return {
    platform: platform === 'ios' || platform === 'android' ? platform : undefined,
    metroHost,
    metroPort,
    bundleUrl,
    launchUrl,
  };
}

export function normalizeOpenDevice(
  value: Record<string, unknown>,
): AgentDeviceSessionDevice | undefined {
  const platform = value.platform;
  const id = readOptionalString(value, 'id');
  const name = readOptionalString(value, 'device');
  if (!isPublicPlatform(platform) || !id || !name) {
    return undefined;
  }
  const target = readDeviceTarget(value, 'target');
  const serial = isSerialAddressablePlatform(platform)
    ? (readOptionalString(value, 'serial') ?? id)
    : undefined;
  const identifiers = {
    ...buildDeviceIdentifiers(platform, id, name),
    ...(serial ? { serial } : {}),
  };
  return {
    platform,
    target,
    id,
    name,
    identifiers,
    ...buildClientDevicePlatformFields(
      platform,
      platform === 'ios' ? (readOptionalString(value, 'device_udid') ?? id) : id,
      {
        simulatorSetPath: readNullableString(value, 'ios_simulator_device_set'),
        serial,
      },
    ),
  };
}

export function normalizeStartupSample(value: unknown): StartupPerfSample | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.durationMs !== 'number' ||
    typeof value.measuredAt !== 'string' ||
    typeof value.method !== 'string'
  ) {
    return undefined;
  }
  return {
    durationMs: value.durationMs,
    measuredAt: value.measuredAt,
    method: value.method,
    appTarget: readOptionalString(value, 'appTarget'),
    appBundleId: readOptionalString(value, 'appBundleId'),
  };
}

export function normalizeTargetShutdownResult(value: unknown): TargetShutdownResult | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.success !== 'boolean' ||
    typeof value.exitCode !== 'number' ||
    typeof value.stdout !== 'string' ||
    typeof value.stderr !== 'string'
  ) {
    return undefined;
  }
  const error = normalizeDaemonError(value.error);
  return {
    success: value.success,
    exitCode: value.exitCode,
    stdout: value.stdout,
    stderr: value.stderr,
    ...(error ? { error } : {}),
  };
}

/**
 * The one normalizer for daemon errors riding inside otherwise-ok results
 * (target-shutdown reports, the open --foreground initial-snapshot failure).
 * Preserves the FULL shape — hint/details/diagnosticId/logPath plus the
 * additive retriable/supportedOn signals — never a code+message truncation,
 * so recovery guidance survives to Node/CLI JSON callers.
 */
const DAEMON_ERROR_STRING_FIELDS = ['hint', 'diagnosticId', 'logPath', 'supportedOn'] as const;

function normalizeDaemonError(value: unknown): DaemonError | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.code !== 'string' || typeof value.message !== 'string') return undefined;
  const error: DaemonError = { code: value.code, message: value.message };
  Object.assign(error, normalizeDaemonErrorCause(value.cause));
  for (const field of DAEMON_ERROR_STRING_FIELDS) {
    const candidate = value[field];
    if (typeof candidate === 'string') error[field] = candidate;
  }
  if (isRecord(value.details)) error.details = value.details;
  if (typeof value.retriable === 'boolean') error.retriable = value.retriable;
  return error;
}

function normalizeDaemonErrorCause(value: unknown): Pick<DaemonError, 'cause'> | undefined {
  const cause = sanitizeErrorCause(value);
  return cause ? { cause } : undefined;
}

/**
 * open --foreground composition extras on an ok open response: the initial
 * snapshot when the foreground-attach capture succeeded, or the FULL capture
 * error (never a code+message truncation) when open succeeded and the
 * composed snapshot did not — the session is open and usable either way.
 */
export function normalizeOpenForegroundComposition(data: Record<string, unknown>): {
  snapshot?: Record<string, unknown>;
  initialSnapshotError?: DaemonError;
} {
  const initialSnapshotError = normalizeDaemonError(data.initialSnapshotError);
  return {
    ...(data.snapshot && typeof data.snapshot === 'object'
      ? { snapshot: data.snapshot as Record<string, unknown> }
      : {}),
    ...(initialSnapshotError ? { initialSnapshotError } : {}),
  };
}

export function readSnapshotNodes(value: unknown): SnapshotNode[] {
  // Snapshot nodes are produced by the daemon snapshot pipeline and treated as trusted here.
  return Array.isArray(value) ? (value as SnapshotNode[]) : [];
}

export function buildMeta(options: InternalRequestOptions): DaemonRequest['meta'] {
  const leaseScope = leaseScopeFromOptions(options);
  return stripUndefined({
    requestId: options.requestId,
    cwd: options.cwd,
    sessionExplicit: options.session !== undefined,
    debug: options.debug,
    includeCost: options.cost,
    responseLevel: options.responseLevel,
    lockPolicy: options.lockPolicy,
    lockPlatform: options.lockPlatform,
    ...leaseScopeToRequestMeta(leaseScope),
    sessionIsolation: options.sessionIsolation,
    installSource: options.installSource,
    retainMaterializedPaths: options.retainMaterializedPaths,
    materializedPathRetentionMs: options.materializedPathRetentionMs,
    materializationId: options.materializationId,
  });
}

export function resolveSessionName(session: string | undefined): string {
  return session ?? DEFAULT_SESSION_NAME;
}
