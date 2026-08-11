import type { SessionAction } from '@agent-device/contracts/session';
import { publicPlatformString } from '@agent-device/kernel/device';
import { normalizeError } from '@agent-device/kernel/errors';
import type { AndroidAdbExecutor } from '../../platforms/android/adb-executor.ts';
import {
  ANDROID_LEGACY_CPU_SAMPLE_DESCRIPTION,
  ANDROID_LEGACY_CPU_SAMPLE_METHOD,
  sampleLegacyAndroidCpuPerf,
} from '../../platforms/android/perf-legacy-cpu.ts';
import type { SessionStore } from '../session-store.ts';
import type { SessionState } from '../types.ts';
import { buildPerfFramesResponseData, buildPerfMemoryResponseData } from './session-perf.ts';
import {
  PERF_STARTUP_SAMPLE_LIMIT,
  PERF_UNAVAILABLE_REASON,
  STARTUP_SAMPLE_DESCRIPTION,
  STARTUP_SAMPLE_METHOD,
  type StartupPerfSample,
} from './session-startup-metrics.ts';

const LEGACY_PERF_METRICS_WARNING =
  'perf metrics, bare perf, and perf sample are deprecated compatibility forms and will be removed in the next major release. Use perf frames, perf memory sample, or a native CPU profile.';

export async function buildLegacyPerfMetricsResponseData(
  session: SessionState,
  options: {
    androidAdb?: AndroidAdbExecutor;
    sessionName: string;
    sessionStore: SessionStore;
  },
): Promise<Record<string, unknown>> {
  // Keep the deprecated aggregate path sequential: Apple frames and physical-device memory
  // sampling can both own an xctrace recording, and concurrent recordings contend for kperf.
  const frames = await buildPerfFramesResponseData(session, options);
  const memory = await buildPerfMemoryResponseData(session, { ...options, action: 'sample' });
  const cpu = await buildLegacyCpuMetric(session, options.androidAdb);
  return {
    session: session.name,
    platform: publicPlatformString(session.device),
    device: session.device.name,
    deviceId: session.device.id,
    metrics: {
      startup: buildLegacyStartupMetric(session.actions),
      cpu,
      fps: frames.metrics.fps,
      memory: memory.metrics?.memory ?? { available: false, reason: PERF_UNAVAILABLE_REASON },
    },
    sampling: {
      startup: {
        method: STARTUP_SAMPLE_METHOD,
        description: STARTUP_SAMPLE_DESCRIPTION,
        unit: 'ms',
      },
      cpu: buildLegacyCpuSamplingMetadata(session),
      fps: frames.sampling.fps,
      memory: memory.sampling.memory,
    },
    warnings: [LEGACY_PERF_METRICS_WARNING],
  };
}

async function buildLegacyCpuMetric(
  session: SessionState,
  androidAdb: AndroidAdbExecutor | undefined,
): Promise<Record<string, unknown>> {
  if (session.device.platform !== 'android') return buildUnavailableLegacyCpuMetric();
  if (!session.appBundleId) {
    return {
      available: false,
      reason: 'No Android app package is associated with this session. Run open <app> first.',
    };
  }
  try {
    return {
      available: true,
      ...(await sampleLegacyAndroidCpuPerf(session.device, session.appBundleId, {
        adb: androidAdb,
      })),
    };
  } catch (reason) {
    const error = normalizeError(reason);
    return { available: false, reason: error.message, error };
  }
}

function buildUnavailableLegacyCpuMetric(): Record<string, unknown> {
  return {
    available: false,
    reason: 'Point CPU sampling is unavailable. Use a native CPU profile for CPU evidence.',
  };
}

function buildLegacyCpuSamplingMetadata(session: SessionState): Record<string, unknown> {
  if (session.device.platform === 'android') {
    return {
      method: ANDROID_LEGACY_CPU_SAMPLE_METHOD,
      description: ANDROID_LEGACY_CPU_SAMPLE_DESCRIPTION,
      unit: 'percent',
      deprecated: true,
    };
  }
  return {
    method: 'deprecated',
    description: 'Use a native CPU profile instead of a point-in-time percentage.',
  };
}

function buildLegacyStartupMetric(actions: SessionAction[]): Record<string, unknown> {
  const samples = readStartupPerfSamples(actions);
  const latest = samples.at(-1);
  return latest
    ? {
        available: true,
        lastDurationMs: latest.durationMs,
        lastMeasuredAt: latest.measuredAt,
        method: STARTUP_SAMPLE_METHOD,
        sampleCount: samples.length,
        samples,
      }
    : {
        available: false,
        reason: 'No startup sample captured yet. Run open <app|url> in this session first.',
        method: STARTUP_SAMPLE_METHOD,
      };
}

function readStartupPerfSamples(actions: SessionAction[]): StartupPerfSample[] {
  const samples: StartupPerfSample[] = [];
  for (const action of actions) {
    const sample = readStartupPerfSample(action);
    if (sample) samples.push(sample);
  }
  return samples.slice(-PERF_STARTUP_SAMPLE_LIMIT);
}

function readStartupPerfSample(action: SessionAction): StartupPerfSample | undefined {
  if (action.command !== 'open') return undefined;
  const startup = action.result?.startup;
  if (!startup || typeof startup !== 'object') return undefined;
  const record = startup as Record<string, unknown>;
  const durationMs = readStartupDuration(record.durationMs);
  const measuredAt = readStartupMeasuredAt(record.measuredAt);
  if (durationMs === undefined || !measuredAt || record.method !== STARTUP_SAMPLE_METHOD) {
    return undefined;
  }
  return {
    durationMs,
    measuredAt,
    method: STARTUP_SAMPLE_METHOD,
    appTarget: readOptionalString(record.appTarget),
    appBundleId: readOptionalString(record.appBundleId),
  };
}

function readStartupDuration(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.round(value));
}

function readStartupMeasuredAt(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
