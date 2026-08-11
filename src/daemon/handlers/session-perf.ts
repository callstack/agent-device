import type { SessionAction } from '@agent-device/contracts/session';
import path from 'node:path';
import type { SessionState } from '../types.ts';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { isApplePlatform, publicPlatformString } from '@agent-device/kernel/device';
import { tryGetPlugin } from '../../core/platform-plugin-registry.ts';
import { registerBuiltinPlatformPlugins } from '../../core/interactors/register-builtins.ts';
import type { AndroidAdbExecutor } from '../../platforms/android/adb-executor.ts';
import {
  ANDROID_HPROF_SNAPSHOT_DESCRIPTION,
  ANDROID_HPROF_SNAPSHOT_METHOD,
  ANDROID_FRAME_SAMPLE_DESCRIPTION,
  ANDROID_FRAME_SAMPLE_METHOD,
  ANDROID_MEMORY_SAMPLE_DESCRIPTION,
  ANDROID_MEMORY_SAMPLE_METHOD,
  captureAndroidHeapSnapshot,
  sampleAndroidFramePerf,
  sampleAndroidMemoryPerf,
} from '../../platforms/android/perf.ts';
import {
  APPLE_MEMGRAPH_SNAPSHOT_DESCRIPTION,
  APPLE_MEMGRAPH_SNAPSHOT_METHOD,
  buildAppleMemorySnapshotSupport,
  buildAppleFrameSamplingMetadata,
  buildAppleMemorySamplingMetadata,
  captureAppleMemorySnapshot,
  sampleAppleFramePerf,
  sampleAppleMemoryPerf,
} from '../../platforms/apple/core/perf.ts';
import {
  HARMONYOS_MEMORY_SAMPLE_DESCRIPTION,
  HARMONYOS_MEMORY_SAMPLE_METHOD,
  sampleHarmonyMemoryPerf,
} from '../../platforms/harmonyos/perf.ts';
import type { PerfKind } from '@agent-device/contracts/observability';
import { SessionStore } from '../session-store.ts';
import { PERF_UNAVAILABLE_REASON } from './session-startup-metrics.ts';

// Populate the PlatformPlugin registry once at module load (idempotent; registers
// only lazy closures, so no leaf code is imported and CLI cold-start is unaffected
// — mirrors the same call in `daemon/app-log.ts`). `supportsPlatformPerfObservations`
// reads the per-platform perf facet from this registry, so it must be populated first.
registerBuiltinPlatformPlugins();

type SettledMetricResult = PromiseSettledResult<Record<string, unknown>>;
type MetricResult =
  | ({ available: true } & Record<string, unknown>)
  | { available: false; reason: string; error?: ReturnType<typeof normalizeError> };
type PerfResponseBase = {
  session: string;
  platform: string;
  device: string;
  deviceId: string;
};
type PerfFramesResponseData = PerfResponseBase & {
  metrics: { fps: unknown };
  sampling: { fps: unknown };
};
type PerfMemoryResponseData = PerfResponseBase & {
  metrics?: { memory: unknown };
  artifact?: Record<string, unknown>;
  sampling: { memory?: unknown; snapshot?: unknown };
  support?: Record<string, unknown>;
};
type BuildPerfResponseOptions = {
  androidAdb?: AndroidAdbExecutor;
};
type BuildPerfMemoryResponseOptions = BuildPerfResponseOptions & {
  action: 'sample' | 'snapshot';
  kind?: PerfKind;
  out?: string;
  cwd?: string;
  sessionName: string;
  sessionStore: SessionStore;
};

const RELATED_PERF_ACTION_LIMIT = 12;

export async function buildPerfFramesResponseData(
  session: SessionState,
  options: BuildPerfResponseOptions = {},
): Promise<PerfFramesResponseData> {
  const response = buildBasePerfFramesResponse(session);

  if (!supportsPlatformPerfObservations(session)) {
    return response;
  }

  if (!session.appBundleId) {
    response.metrics.fps = { available: false, reason: buildMissingAppPerfReason(session) };
    return response;
  }

  await applyFramePerfMetric(response, session, session.appBundleId, options);
  return response;
}

export async function buildPerfMemoryResponseData(
  session: SessionState,
  options: BuildPerfMemoryResponseOptions,
): Promise<PerfMemoryResponseData> {
  const response = buildBasePerfMemoryResponse(session);

  if (!supportsPlatformPerfObservations(session)) {
    if (options.action === 'snapshot') {
      const kind = resolveMemorySnapshotKind(session, options.kind);
      response.artifact = unsupportedMemorySnapshotArtifact(session, kind);
      response.support =
        readSupportRecord(response.artifact.support) ?? buildMemorySnapshotSupport(session);
      return response;
    }
    response.metrics = { memory: { available: false, reason: PERF_UNAVAILABLE_REASON } };
    return response;
  }

  if (options.action === 'sample') {
    response.metrics = {
      memory: await buildMemorySampleMetric(session, options),
    };
    return response;
  }

  response.artifact = await buildMemorySnapshotArtifact(session, options);
  response.support =
    readSupportRecord(response.artifact.support) ?? buildMemorySnapshotSupport(session);
  return response;
}

function buildDefaultUnavailableFrameMetric(): Record<string, unknown> {
  return {
    available: false,
    reason:
      'Dropped-frame sampling is currently available only on Android app sessions and connected iOS device app sessions.',
  };
}

function buildBasePerfFramesResponse(session: SessionState): PerfFramesResponseData {
  return {
    session: session.name,
    platform: publicPlatformString(session.device),
    device: session.device.name,
    deviceId: session.device.id,
    metrics: {
      fps: buildDefaultUnavailableFrameMetric(),
    },
    sampling: {
      fps: buildFrameSamplingMetadata(session),
    },
  };
}

function buildBasePerfMemoryResponse(session: SessionState): PerfMemoryResponseData {
  return {
    session: session.name,
    platform: publicPlatformString(session.device),
    device: session.device.name,
    deviceId: session.device.id,
    sampling: {
      memory: buildMemorySamplingMetadata(session),
      snapshot: buildMemorySnapshotSamplingMetadata(session),
    },
  };
}

async function applyFramePerfMetric(
  response: PerfFramesResponseData,
  session: SessionState,
  appBundleId: string,
  options: BuildPerfResponseOptions,
): Promise<void> {
  if (session.device.platform === 'harmonyos') return;
  const result =
    session.device.platform === 'android'
      ? await settleMetric(
          sampleAndroidFramePerf(session.device, appBundleId, {
            adb: options.androidAdb,
          }),
        )
      : await settleMetric(sampleAppleFramePerf(session.device, appBundleId));
  response.metrics.fps = enrichFrameMetricWithSessionContext(buildMetricResult(result), session);
}

function supportsPlatformPerfObservations(session: SessionState): boolean {
  // Routes the platform gate through the PlatformPlugin perf facet (issue #974).
  // Apple/Android carry `perf.supportsObservations`; linux/web (and any unregistered
  // platform) fall through to `false`, matching the former hand predicate. The
  // daemon perf routing parity test pins this equivalence.
  return tryGetPlugin(session.device.platform)?.perf?.supportsObservations(session.device) ?? false;
}

function buildMissingAppPerfReason(session: SessionState): string {
  if (session.device.platform === 'android') {
    return 'No Android app package is associated with this session. Run open <app> first.';
  }
  if (session.device.platform === 'harmonyos') {
    return 'No HarmonyOS app bundle is associated with this session. Run open <app> first.';
  }
  return 'No Apple app bundle ID is associated with this session. Run open <app> first.';
}

function buildMemorySamplingMetadata(session: SessionState): Record<string, unknown> {
  if (session.device.platform === 'android') {
    return {
      method: ANDROID_MEMORY_SAMPLE_METHOD,
      description: ANDROID_MEMORY_SAMPLE_DESCRIPTION,
      unit: 'kB',
      topConsumerLimit: 5,
    };
  }
  if (session.device.platform === 'harmonyos') {
    return {
      method: HARMONYOS_MEMORY_SAMPLE_METHOD,
      description: HARMONYOS_MEMORY_SAMPLE_DESCRIPTION,
      unit: 'kB',
      topConsumerLimit: 1,
    };
  }
  return buildAppleMemorySamplingMetadata(session.device);
}

function buildMemorySnapshotSamplingMetadata(session: SessionState): Record<string, unknown> {
  if (session.device.platform === 'android') {
    return {
      method: ANDROID_HPROF_SNAPSHOT_METHOD,
      description: ANDROID_HPROF_SNAPSHOT_DESCRIPTION,
      defaultKind: 'android-hprof',
      artifactOnly: true,
    };
  }
  if (session.device.platform === 'harmonyos') {
    return {
      method: 'unsupported',
      description: 'HarmonyOS memory snapshot capture is not available through HDC.',
      artifactOnly: true,
    };
  }
  return {
    method: APPLE_MEMGRAPH_SNAPSHOT_METHOD,
    description: APPLE_MEMGRAPH_SNAPSHOT_DESCRIPTION,
    defaultKind: 'memgraph',
    artifactOnly: true,
  };
}

function buildFrameSamplingMetadata(session: SessionState): Record<string, unknown> {
  if (session.device.platform === 'android') {
    return {
      method: ANDROID_FRAME_SAMPLE_METHOD,
      description: ANDROID_FRAME_SAMPLE_DESCRIPTION,
      unit: 'percent',
      primaryField: 'droppedFramePercent',
      window: 'since previous Android gfxinfo reset or app process start',
      resetsAfterRead: true,
      relatedActionsLimit: RELATED_PERF_ACTION_LIMIT,
    };
  }
  if (session.device.platform === 'harmonyos') return buildDefaultUnavailableFrameMetric();
  return buildAppleFrameSamplingMetadata(session.device);
}

async function buildMemorySampleMetric(
  session: SessionState,
  options: BuildPerfResponseOptions,
): Promise<MetricResult> {
  if (!session.appBundleId) {
    return { available: false, reason: buildMissingAppPerfReason(session) };
  }

  const result =
    session.device.platform === 'android'
      ? await settleMetric(
          sampleAndroidMemoryPerf(session.device, session.appBundleId, {
            adb: options.androidAdb,
          }),
        )
      : session.device.platform === 'harmonyos'
        ? await settleMetric(sampleHarmonyMemoryPerf(session.device, session.appBundleId))
        : await settleMetric(sampleAppleSessionMemoryPerf(session));
  return buildMetricResult(result);
}

async function sampleAppleSessionMemoryPerf(
  session: SessionState,
): Promise<Record<string, unknown>> {
  if (!session.appBundleId) {
    throw new AppError('INVALID_ARGS', buildMissingAppPerfReason(session));
  }
  return await sampleAppleMemoryPerf(session.device, session.appBundleId);
}

async function buildMemorySnapshotArtifact(
  session: SessionState,
  options: BuildPerfMemoryResponseOptions,
): Promise<Record<string, unknown>> {
  if (!session.appBundleId) {
    throw new AppError('INVALID_ARGS', buildMissingAppPerfReason(session), {
      hint: 'Run open <app> first so perf memory snapshot can resolve the app process.',
    });
  }

  const kind = resolveMemorySnapshotKind(session, options.kind);
  const outPath = resolveMemorySnapshotOutPath(options, kind);
  if (session.device.platform === 'android') {
    if (kind !== 'android-hprof') return unsupportedMemorySnapshotArtifact(session, kind);
    return await captureAndroidHeapSnapshot(session.device, session.appBundleId, outPath, {
      adb: options.androidAdb,
    });
  }
  if (session.device.platform === 'harmonyos') {
    return unsupportedMemorySnapshotArtifact(session, kind);
  }
  if (kind !== 'memgraph') return unsupportedMemorySnapshotArtifact(session, kind);
  return await captureAppleMemorySnapshot(session.device, session.appBundleId, outPath);
}

function resolveMemorySnapshotKind(
  session: SessionState,
  requestedKind: PerfKind | undefined,
): PerfKind {
  if (requestedKind) return requestedKind;
  return session.device.platform === 'android' ? 'android-hprof' : 'memgraph';
}

function resolveMemorySnapshotOutPath(
  options: BuildPerfMemoryResponseOptions,
  kind: PerfKind,
): string {
  if (options.out) return SessionStore.expandHome(options.out, options.cwd);
  const extension =
    kind === 'android-hprof' ? 'hprof' : kind === 'memgraph' ? 'memgraph' : 'artifact';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sessionDir = options.sessionStore.ensureSessionDir(options.sessionName);
  return path.join(sessionDir, 'artifacts', `memory-${kind}-${timestamp}.${extension}`);
}

function unsupportedMemorySnapshotArtifact(
  session: SessionState,
  kind: PerfKind,
): Record<string, unknown> {
  const support = buildMemorySnapshotSupport(session);
  const guidance = buildUnsupportedMemorySnapshotGuidance(session, kind);
  return {
    available: false,
    kind,
    reason: guidance.reason,
    hint: guidance.hint,
    support,
  };
}

function buildUnsupportedMemorySnapshotGuidance(
  session: SessionState,
  kind: PerfKind,
): { reason: string; hint: string } {
  if (session.device.platform === 'android') {
    return {
      reason: `Android perf memory snapshot supports android-hprof, not ${kind}.`,
      hint: 'Use perf memory snapshot --kind android-hprof for Android Java heap artifacts.',
    };
  }
  if (isApplePlatform(session.device.platform)) {
    return {
      reason: `Apple perf memory snapshot supports memgraph, not ${kind}.`,
      hint: 'Use perf memory snapshot --kind memgraph for supported Apple app sessions.',
    };
  }
  return {
    reason: `Memory snapshot artifacts are not supported on ${session.device.platform}.`,
    hint: 'Use perf memory sample where supported, or run the snapshot against Android, iOS simulator, or macOS.',
  };
}

function buildMemorySnapshotSupport(session: SessionState): Record<string, unknown> {
  if (session.device.platform === 'android') {
    return {
      platform: session.device.platform,
      defaultKind: 'android-hprof',
      androidHprof: true,
      memgraph: false,
      heapprofd: false,
      heapprofdDecision:
        'Deferred until Android Perfetto/heapprofd plumbing is available in the perf trace slice.',
    };
  }
  if (!isApplePlatform(session.device.platform)) {
    return {
      platform: session.device.platform,
      defaultKind: 'memgraph',
      androidHprof: false,
      memgraph: false,
      heapprofd: false,
      reason: 'Memory snapshot artifacts are available only on Android, iOS simulator, and macOS.',
      hint: 'Use perf memory sample where supported, or switch to a platform with memory artifact support.',
      heapprofdDecision:
        'Deferred because heapprofd is Android/Perfetto-specific and outside this memory artifact slice.',
    };
  }
  return {
    ...buildAppleMemorySnapshotSupport(session.device),
    androidHprof: false,
    heapprofd: false,
    heapprofdDecision:
      'Deferred because heapprofd is Android/Perfetto-specific and outside this memory artifact slice.',
  };
}

function readSupportRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function settleMetric<T extends object>(promise: Promise<T>): Promise<SettledMetricResult> {
  try {
    return { status: 'fulfilled', value: (await promise) as Record<string, unknown> };
  } catch (reason) {
    return { status: 'rejected', reason };
  }
}

function buildMetricResult(result: SettledMetricResult): MetricResult {
  if (result.status === 'fulfilled') {
    return { available: true, ...result.value };
  }
  const error = normalizeError(result.reason);
  return {
    available: false,
    reason: error.message,
    error,
  };
}

function enrichFrameMetricWithSessionContext(
  metric: MetricResult,
  session: SessionState,
): MetricResult {
  if (metric.available !== true) return metric;
  const relatedActions = buildRelatedPerfActions(session.actions, metric);
  if (relatedActions.length === 0) return metric;
  return {
    ...metric,
    relatedActions,
  };
}

function buildRelatedPerfActions(
  actions: SessionAction[],
  metric: Record<string, unknown>,
): Array<{
  command: string;
  at: string;
  offsetMs?: number;
  target?: string;
}> {
  const windowStartedAtMs = parseIsoTime(metric.windowStartedAt);
  const windowEndedAtMs = parseIsoTime(metric.windowEndedAt) ?? parseIsoTime(metric.measuredAt);
  if (windowStartedAtMs === undefined || windowEndedAtMs === undefined) return [];

  return actions
    .filter((action) => action.ts >= windowStartedAtMs && action.ts <= windowEndedAtMs)
    .map((action) => ({
      command: action.command,
      at: new Date(action.ts).toISOString(),
      offsetMs: Math.max(0, Math.round(action.ts - windowStartedAtMs)),
      target: readActionTarget(action),
    }))
    .slice(-RELATED_PERF_ACTION_LIMIT);
}

function parseIsoTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function readActionTarget(action: SessionAction): string | undefined {
  const result = action.result;
  if (!result) return undefined;
  for (const key of ['refLabel', 'ref', 'appName', 'appBundleId']) {
    const value = result[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}
