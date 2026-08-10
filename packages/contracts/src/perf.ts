import { defineStringEnum } from './string-enum.ts';

export const PERF_AREA_VALUES = ['metrics', 'frames', 'memory', 'cpu', 'trace'] as const;
export const PERF_ACTION_VALUES = ['sample', 'snapshot', 'start', 'stop', 'report'] as const;
export const PERF_SUBJECT_VALUES = ['profile'] as const;
export const PERF_KIND_VALUES = [
  'xctrace',
  'simpleperf',
  'perfetto',
  'android-hprof',
  'memgraph',
] as const;
const PERF_MEMORY_KIND_VALUES = ['android-hprof', 'memgraph'] as const;
const PERF_AREAS = defineStringEnum(PERF_AREA_VALUES);
const PERF_ACTIONS = defineStringEnum(PERF_ACTION_VALUES);
const PERF_SUBJECTS = defineStringEnum(PERF_SUBJECT_VALUES);
const PERF_KINDS = defineStringEnum(PERF_KIND_VALUES);
const PERF_MEMORY_KINDS = defineStringEnum(PERF_MEMORY_KIND_VALUES);

export type PerfArea = (typeof PERF_AREA_VALUES)[number];
export type PerfAction = (typeof PERF_ACTION_VALUES)[number];
export type PerfSubject = (typeof PERF_SUBJECT_VALUES)[number];
export type PerfKind = (typeof PERF_KIND_VALUES)[number];

export const PERF_AREA_ERROR_MESSAGE = 'perf area must be metrics, frames, memory, cpu, or trace';
export const PERF_ACTION_ERROR_MESSAGE =
  'perf action must be sample, snapshot, start, stop, or report';
export const PERF_SUBJECT_ERROR_MESSAGE = 'perf cpu requires profile';
export const PERF_KIND_ERROR_MESSAGE =
  'perf --kind must be xctrace, simpleperf, perfetto, android-hprof, or memgraph';
export const PERF_MEMORY_KIND_ERROR_MESSAGE =
  'perf memory snapshot --kind must be android-hprof or memgraph';

export const isPerfArea = PERF_AREAS.is;

export const isPerfAction = PERF_ACTIONS.is;

export const isPerfSubject = PERF_SUBJECTS.is;

export const isPerfKind = PERF_KINDS.is;

export const isPerfMemoryKind = PERF_MEMORY_KINDS.is;

/**
 * The daemon-owned `perf metrics` sampler discriminant. A PLATFORM-NEUTRAL string tag
 * naming which family owns a device's `perf metrics` sampler; the daemon maps it back to
 * the concrete sampler via {@link PERF_METRICS_SAMPLERS_BY_TAG}. The
 * {@link PlatformPlugin.perf} facet returns this tag (type-only in the plugin, exactly
 * as a type-only value), so core/platforms never carry the
 * daemon-owned sampling composition. Only families that expose perf metrics carry the tag
 * (Apple, Android, and HarmonyOS); it is consulted solely after the support gate admits the platform.
 */
export type PerfMetricsSamplerTag = 'apple' | 'android' | 'harmonyos';
