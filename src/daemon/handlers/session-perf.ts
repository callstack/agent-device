import path from 'node:path';
import type { SessionAction, SessionState } from '../types.ts';
import { AppError, normalizeError } from '../../utils/errors.ts';
import { isApplePlatform } from '../../utils/device.ts';
import type { AndroidAdbExecutor } from '../../platforms/android/adb-executor.ts';
import {
  ANDROID_HPROF_SNAPSHOT_DESCRIPTION,
  ANDROID_HPROF_SNAPSHOT_METHOD,
  ANDROID_CPU_SAMPLE_DESCRIPTION,
  ANDROID_CPU_SAMPLE_METHOD,
  ANDROID_FRAME_SAMPLE_DESCRIPTION,
  ANDROID_FRAME_SAMPLE_METHOD,
  ANDROID_MEMORY_SAMPLE_DESCRIPTION,
  ANDROID_MEMORY_SAMPLE_METHOD,
  captureAndroidHeapSnapshot,
  sampleAndroidCpuPerf,
  sampleAndroidFramePerf,
  sampleAndroidMemoryPerf,
} from '../../platforms/android/perf.ts';
import {
  APPLE_MEMGRAPH_SNAPSHOT_DESCRIPTION,
  APPLE_MEMGRAPH_SNAPSHOT_METHOD,
  buildAppleMemorySnapshotSupport,
  buildAppleFrameSamplingMetadata,
  buildAppleSamplingMetadata,
  captureAppleMemorySnapshot,
  sampleAppleFramePerf,
  sampleApplePerfMetrics,
} from '../../platforms/ios/perf.ts';
import type { PerfKind } from '../../contracts/perf.ts';
import { SessionStore } from '../session-store.ts';
import {
  PERF_STARTUP_SAMPLE_LIMIT,
  PERF_UNAVAILABLE_REASON,
  STARTUP_SAMPLE_DESCRIPTION,
  STARTUP_SAMPLE_METHOD,
  type StartupPerfSample,
} from './session-startup-metrics.ts';

type SettledMetricResult = PromiseSettledResult<Record<string, unknown>>;
type MetricResult =
  | ({ available: true } & Record<string, unknown>)
  | { available: false; reason: string; error?: ReturnType<typeof normalizeError> };
type PerfResponseData = {
  session: string;
  platform: string;
  device: string;
  deviceId: string;
  metrics: Record<string, unknown>;
  sampling: Record<string, unknown>;
};
type PerfFramesResponseData = Omit<PerfResponseData, 'metrics' | 'sampling'> & {
  metrics: { fps: unknown };
  sampling: { fps: unknown };
};
type PerfMemoryResponseData = Omit<PerfResponseData, 'metrics' | 'sampling'> & {
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

function readStartupPerfSamples(actions: SessionAction[]): StartupPerfSample[] {
  const samples: StartupPerfSample[] = [];
  for (const action of actions) {
    if (action.command !== 'open') continue;
    const startup = action.result?.startup;
    if (!startup || typeof startup !== 'object') continue;
    const record = startup as Record<string, unknown>;
    if (
      typeof record.durationMs !== 'number' ||
      !Number.isFinite(record.durationMs) ||
      typeof record.measuredAt !== 'string' ||
      record.measuredAt.trim().length === 0 ||
      record.method !== STARTUP_SAMPLE_METHOD
    ) {
      continue;
    }
    samples.push({
      durationMs: Math.max(0, Math.round(record.durationMs)),
      measuredAt: record.measuredAt,
      method: STARTUP_SAMPLE_METHOD,
      appTarget:
        typeof record.appTarget === 'string' && record.appTarget.length > 0
          ? record.appTarget
          : undefined,
      appBundleId:
        typeof record.appBundleId === 'string' && record.appBundleId.length > 0
          ? record.appBundleId
          : undefined,
    });
  }
  return samples.slice(-PERF_STARTUP_SAMPLE_LIMIT);
}

export async function buildPerfResponseData(
  session: SessionState,
  options: BuildPerfResponseOptions = {},
): Promise<PerfResponseData> {
  const response = buildBasePerfResponse(session);

  if (!supportsPlatformPerfMetrics(session)) {
    return response;
  }

  if (!session.appBundleId) {
    applyMissingAppPerfMetrics(response, session);
    return response;
  }

  if (session.device.platform === 'android') {
    await applyAndroidPerfMetrics(response, session, session.appBundleId, options);
    return response;
  }

  await applyApplePerfMetrics(response, session, session.appBundleId);
  return response;
}

export async function buildPerfFramesResponseData(
  session: SessionState,
  options: BuildPerfResponseOptions = {},
): Promise<PerfFramesResponseData> {
  const response = buildBasePerfFramesResponse(session);

  if (!supportsPlatformPerfMetrics(session)) {
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

  if (!supportsPlatformPerfMetrics(session)) {
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

function buildBasePerfResponse(session: SessionState): PerfResponseData {
  const startupSamples = readStartupPerfSamples(session.actions);
  const latestStartupSample = startupSamples.at(-1);
  const startupMetric = latestStartupSample
    ? {
        available: true,
        lastDurationMs: latestStartupSample.durationMs,
        lastMeasuredAt: latestStartupSample.measuredAt,
        method: STARTUP_SAMPLE_METHOD,
        sampleCount: startupSamples.length,
        samples: startupSamples,
      }
    : {
        available: false,
        reason: 'No startup sample captured yet. Run open <app|url> in this session first.',
        method: STARTUP_SAMPLE_METHOD,
      };
  return {
    session: session.name,
    platform: session.device.platform,
    device: session.device.name,
    deviceId: session.device.id,
    metrics: {
      startup: startupMetric,
      ...buildDefaultUnavailableMetrics(),
    },
    sampling: {
      startup: {
        method: STARTUP_SAMPLE_METHOD,
        description: STARTUP_SAMPLE_DESCRIPTION,
        unit: 'ms',
      },
      ...buildPlatformSamplingMetadata(session),
    },
  };
}

function buildDefaultUnavailableMetrics(): Record<string, unknown> {
  return {
    fps: buildDefaultUnavailableFrameMetric(),
    memory: { available: false, reason: PERF_UNAVAILABLE_REASON },
    cpu: { available: false, reason: PERF_UNAVAILABLE_REASON },
  };
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
    platform: session.device.platform,
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
    platform: session.device.platform,
    device: session.device.name,
    deviceId: session.device.id,
    sampling: {
      memory: buildMemorySamplingMetadata(session),
      snapshot: buildMemorySnapshotSamplingMetadata(session),
    },
  };
}

function applyMissingAppPerfMetrics(response: PerfResponseData, session: SessionState): void {
  const reason = buildMissingAppPerfReason(session);
  response.metrics.fps = { available: false, reason };
  response.metrics.memory = { available: false, reason };
  response.metrics.cpu = { available: false, reason };
}

async function applyAndroidPerfMetrics(
  response: PerfResponseData,
  session: SessionState,
  appBundleId: string,
  options: BuildPerfResponseOptions,
): Promise<void> {
  const results = await sampleAndroidPerfResults(session, appBundleId, options);
  applySampledPerfMetrics(response, session, results);
}

async function applyApplePerfMetrics(
  response: PerfResponseData,
  session: SessionState,
  appBundleId: string,
): Promise<void> {
  const results = await sampleApplePerfResultsForSession(session, appBundleId);
  applySampledPerfMetrics(response, session, results);
}

function applySampledPerfMetrics(
  response: PerfResponseData,
  session: SessionState,
  results: {
    memory: SettledMetricResult;
    cpu: SettledMetricResult;
    fps: SettledMetricResult;
  },
): void {
  response.metrics.memory = buildMetricResult(results.memory);
  response.metrics.cpu = buildMetricResult(results.cpu);
  response.metrics.fps = enrichFrameMetricWithSessionContext(
    buildMetricResult(results.fps),
    session,
  );
}

async function applyFramePerfMetric(
  response: PerfFramesResponseData,
  session: SessionState,
  appBundleId: string,
  options: BuildPerfResponseOptions,
): Promise<void> {
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

function supportsPlatformPerfMetrics(session: SessionState): boolean {
  return (
    session.device.platform === 'android' ||
    session.device.platform === 'ios' ||
    session.device.platform === 'macos'
  );
}

function buildMissingAppPerfReason(session: SessionState): string {
  if (session.device.platform === 'android') {
    return 'No Android app package is associated with this session. Run open <app> first.';
  }
  return 'No Apple app bundle ID is associated with this session. Run open <app> first.';
}

function buildPlatformSamplingMetadata(session: SessionState): Record<string, unknown> {
  if (session.device.platform === 'android') {
    return {
      memory: {
        method: ANDROID_MEMORY_SAMPLE_METHOD,
        description: ANDROID_MEMORY_SAMPLE_DESCRIPTION,
        unit: 'kB',
      },
      cpu: {
        method: ANDROID_CPU_SAMPLE_METHOD,
        description: ANDROID_CPU_SAMPLE_DESCRIPTION,
        unit: 'percent',
      },
      fps: {
        method: ANDROID_FRAME_SAMPLE_METHOD,
        description: ANDROID_FRAME_SAMPLE_DESCRIPTION,
        unit: 'percent',
        primaryField: 'droppedFramePercent',
        window: 'since previous Android gfxinfo reset or app process start',
        resetsAfterRead: true,
        relatedActionsLimit: RELATED_PERF_ACTION_LIMIT,
      },
    };
  }
  return buildAppleSamplingMetadata(session.device);
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
  return buildAppleSamplingMetadata(session.device).memory as Record<string, unknown>;
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
  return buildAppleFrameSamplingMetadata(session.device);
}

async function sampleAndroidPerfResults(
  session: SessionState,
  appBundleId: string,
  options: BuildPerfResponseOptions,
): Promise<{
  memory: SettledMetricResult;
  cpu: SettledMetricResult;
  fps: SettledMetricResult;
}> {
  const androidPerfOptions = { adb: options.androidAdb };
  const [memory, cpu, fps] = await Promise.allSettled([
    sampleAndroidMemoryPerf(session.device, appBundleId, androidPerfOptions),
    sampleAndroidCpuPerf(session.device, appBundleId, androidPerfOptions),
    sampleAndroidFramePerf(session.device, appBundleId, androidPerfOptions),
  ]);
  return { memory, cpu, fps };
}

async function sampleApplePerfResultsForSession(
  session: SessionState,
  appBundleId: string,
): Promise<{
  memory: SettledMetricResult;
  cpu: SettledMetricResult;
  fps: SettledMetricResult;
}> {
  const fps = await settleMetric(sampleAppleFramePerf(session.device, appBundleId));
  const processSample = await settleMetric(sampleApplePerfMetrics(session.device, appBundleId));
  if (processSample.status === 'fulfilled') {
    const processMetrics = processSample.value as {
      memory: Record<string, unknown>;
      cpu: Record<string, unknown>;
    };
    return {
      memory: { status: 'fulfilled', value: processMetrics.memory },
      cpu: { status: 'fulfilled', value: processMetrics.cpu },
      fps,
    };
  }
  return {
    memory: { status: 'rejected', reason: processSample.reason },
    cpu: { status: 'rejected', reason: processSample.reason },
    fps,
  };
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
      : await settleMetric(sampleAppleMemoryPerf(session));
  return buildMetricResult(result);
}

async function sampleAppleMemoryPerf(session: SessionState): Promise<Record<string, unknown>> {
  if (!session.appBundleId) {
    throw new AppError('INVALID_ARGS', buildMissingAppPerfReason(session));
  }
  const processSample = await sampleApplePerfMetrics(session.device, session.appBundleId);
  return processSample.memory;
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
