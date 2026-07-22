import type { DaemonRequest, SessionRuntimeHints } from '../daemon/types.ts';
import { AppError, type NormalizedError } from '../kernel/errors.ts';
import type { SnapshotNode } from '../kernel/snapshot.ts';
import { buildAppIdentifiers, buildDeviceIdentifiers } from '../contracts/result-serialization.ts';
import { isAppleOs, isApplePlatform, isPublicPlatform, type AppleOS } from '../kernel/device.ts';
import { leaseScopeFromOptions, leaseScopeToRequestMeta } from '../core/lease-scope.ts';
import type {
  AgentDeviceDevice,
  AgentDeviceSession,
  AgentDeviceSessionDevice,
  AppDeployResult,
  AppInstallFromSourceResult,
  InternalRequestOptions,
  MaterializationReleaseResult,
  StartupPerfSample,
  TargetShutdownResult,
} from './client-types.ts';
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
      ...buildClientDevicePlatformFields(
        platform,
        id,
        readNullableString(record, 'ios_simulator_device_set'),
      ),
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
  simulatorSetPath?: string | null,
): Pick<AgentDeviceSessionDevice, 'ios' | 'android'> {
  return {
    ios:
      platform === 'ios'
        ? {
            udid: id,
            ...(simulatorSetPath !== undefined ? { simulatorSetPath } : {}),
          }
        : undefined,
    android: platform === 'android' ? { serial: id } : undefined,
  };
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
  const identifiers = buildDeviceIdentifiers(platform, id, name);
  return {
    platform,
    target,
    id,
    name,
    identifiers,
    ios:
      platform === 'ios'
        ? {
            udid: readOptionalString(value, 'device_udid') ?? id,
            simulatorSetPath: readNullableString(value, 'ios_simulator_device_set'),
          }
        : undefined,
    android:
      platform === 'android' ? { serial: readOptionalString(value, 'serial') ?? id } : undefined,
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
  const error = normalizeTargetShutdownError(value.error);
  return {
    success: value.success,
    exitCode: value.exitCode,
    stdout: value.stdout,
    stderr: value.stderr,
    ...(error ? { error } : {}),
  };
}

function normalizeTargetShutdownError(value: unknown): NormalizedError | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.code !== 'string' || typeof value.message !== 'string') return undefined;
  return {
    code: value.code,
    message: value.message,
    ...(typeof value.hint === 'string' ? { hint: value.hint } : {}),
    ...(typeof value.diagnosticId === 'string' ? { diagnosticId: value.diagnosticId } : {}),
    ...(typeof value.logPath === 'string' ? { logPath: value.logPath } : {}),
    ...(isRecord(value.details) ? { details: value.details } : {}),
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
