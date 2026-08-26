import { AppError } from '@agent-device/kernel/errors';
import type { PerfKind } from './facades/observability.ts';
import { isPerfMemoryKind } from './perf.ts';
import {
  perfFramesUse,
  perfMemorySampleUse,
  perfMemorySnapshotUse,
  perfNativeCaptureRecoveryUse,
  perfNativeCaptureStartUse,
  perfProfileReportUse,
} from './platform-runtime-operations.ts';

export type PerfRuntimeRequest =
  | Readonly<{ area: 'frames'; action: 'sample' }>
  | Readonly<{
      area: 'memory';
      action: 'sample' | 'snapshot';
      kind?: PerfKind;
      outPath?: string;
    }>
  | Readonly<{
      area: 'cpu';
      subject: 'profile';
      action: 'start' | 'stop' | 'report';
      kind: 'xctrace' | 'simpleperf';
      template?: string;
      outPath?: string;
      tracePath?: string;
    }>
  | Readonly<{
      area: 'trace';
      action: 'start' | 'stop';
      kind: 'xctrace' | 'perfetto';
      template?: string;
      outPath?: string;
    }>;

export type PerfRuntimePlan =
  | Readonly<{
      kind: 'frames';
      request: Extract<PerfRuntimeRequest, { area: 'frames' }>;
      use: typeof perfFramesUse;
    }>
  | Readonly<{
      kind: 'memory-sample';
      request: Extract<PerfRuntimeRequest, { area: 'memory' }>;
      use: typeof perfMemorySampleUse;
    }>
  | Readonly<{
      kind: 'memory-snapshot';
      request: Extract<PerfRuntimeRequest, { area: 'memory' }>;
      use: typeof perfMemorySnapshotUse;
    }>
  | Readonly<{
      kind: 'capture-start';
      request: Extract<PerfRuntimeRequest, { area: 'cpu' | 'trace' }>;
      use: typeof perfNativeCaptureStartUse;
    }>
  | Readonly<{
      kind: 'capture-stop';
      request: Extract<PerfRuntimeRequest, { area: 'cpu' | 'trace' }>;
    }>
  | Readonly<{
      kind: 'profile-report';
      request: Extract<PerfRuntimeRequest, { area: 'cpu' }>;
      use: typeof perfProfileReportUse;
    }>;

export function resolvePerfRuntimePlan(request: PerfRuntimeRequest): PerfRuntimePlan {
  if (request.area === 'frames') {
    return Object.freeze({ kind: 'frames', request, use: perfFramesUse });
  }
  if (request.area === 'memory') {
    return request.action === 'snapshot'
      ? Object.freeze({ kind: 'memory-snapshot', request, use: perfMemorySnapshotUse })
      : Object.freeze({ kind: 'memory-sample', request, use: perfMemorySampleUse });
  }
  if (request.area === 'trace') {
    return request.action === 'start'
      ? Object.freeze({ kind: 'capture-start', request, use: perfNativeCaptureStartUse })
      : Object.freeze({ kind: 'capture-stop', request });
  }
  switch (request.action) {
    case 'start':
      return Object.freeze({ kind: 'capture-start', request, use: perfNativeCaptureStartUse });
    case 'stop':
      return Object.freeze({ kind: 'capture-stop', request });
    case 'report':
      return Object.freeze({ kind: 'profile-report', request, use: perfProfileReportUse });
  }
}

export { perfNativeCaptureRecoveryUse };

export function parsePerfRuntimeRequest(
  input: Readonly<{
    positionals?: readonly string[];
    kind?: string;
    outPath?: string;
  }>,
): PerfRuntimeRequest {
  const values = input.positionals ?? [];
  const area = values[0]?.toLowerCase();
  if (area === 'frames') {
    const action = values[1]?.toLowerCase();
    if (
      (action !== undefined && action !== 'sample') ||
      values.length > 2 ||
      input.kind !== undefined
    ) {
      throw new AppError(
        'INVALID_ARGS',
        'perf action must be frames, memory sample|snapshot, cpu profile start|stop|report, or trace start|stop',
      );
    }
    return Object.freeze({ area, action: 'sample' });
  }
  if (area === 'memory') return parseMemoryRequest(values, input);
  if (area === 'cpu') return parseCpuRequest(values, input.outPath);
  if (area === 'trace') return parseTraceRequest(values, input.outPath);
  throw new AppError('INVALID_ARGS', 'perf requires frames, memory, cpu, or trace');
}

// This is the finite CLI grammar boundary; each branch rejects one unsupported surface form.
// fallow-ignore-next-line complexity
function parseMemoryRequest(
  values: readonly string[],
  input: Readonly<{ kind?: string; outPath?: string }>,
): PerfRuntimeRequest {
  const action = (values[1] ?? 'sample').toLowerCase();
  if (action !== 'sample' && action !== 'snapshot') {
    throw new AppError('INVALID_ARGS', 'perf memory requires sample or snapshot');
  }
  if (input.kind !== undefined && action !== 'snapshot') {
    throw new AppError('INVALID_ARGS', '--kind is only supported with perf memory snapshot');
  }
  if (action === 'sample' && values.length > 2) {
    throw new AppError('INVALID_ARGS', 'perf memory sample does not accept additional positionals');
  }
  if (action === 'snapshot' && values.length > 3) {
    throw new AppError('INVALID_ARGS', 'perf memory snapshot accepts at most one positional kind');
  }
  const kind = input.kind ?? values[2];
  if (kind !== undefined && !isPerfMemoryKind(kind)) {
    throw new AppError(
      'INVALID_ARGS',
      'perf memory snapshot --kind must be android-hprof or memgraph',
    );
  }
  return Object.freeze({
    area: 'memory',
    action,
    ...(kind === undefined ? {} : { kind }),
    ...(input.outPath === undefined ? {} : { outPath: input.outPath }),
  });
}

// This is the finite CLI grammar boundary; each branch rejects one unsupported surface form.
// fallow-ignore-next-line complexity
function parseCpuRequest(
  values: readonly string[],
  flaggedOut: string | undefined,
): PerfRuntimeRequest {
  if (values[1]?.toLowerCase() !== 'profile') {
    throw new AppError('INVALID_ARGS', 'perf cpu requires profile');
  }
  const action = values[2]?.toLowerCase();
  if (action !== 'start' && action !== 'stop' && action !== 'report') {
    throw new AppError('INVALID_ARGS', 'perf cpu profile action must be start, stop, or report');
  }
  const kind = values[3]?.toLowerCase();
  if (kind !== 'xctrace' && kind !== 'simpleperf') {
    throw new AppError('INVALID_ARGS', 'perf cpu profile requires --kind xctrace or simpleperf');
  }
  const outPath = flaggedOut ?? values[5];
  return Object.freeze({
    area: 'cpu',
    subject: 'profile',
    action,
    kind,
    ...(values[4] ? { template: values[4] } : {}),
    ...(outPath ? { outPath } : {}),
    ...(values[6] ? { tracePath: values[6] } : {}),
  });
}

function parseTraceRequest(
  values: readonly string[],
  flaggedOut: string | undefined,
): PerfRuntimeRequest {
  const action = values[1]?.toLowerCase();
  if (action !== 'start' && action !== 'stop') {
    throw new AppError('INVALID_ARGS', 'perf trace action must be start or stop');
  }
  const kind = values[2]?.toLowerCase();
  if (kind !== 'xctrace' && kind !== 'perfetto') {
    throw new AppError('INVALID_ARGS', 'perf trace requires --kind xctrace or perfetto');
  }
  const outPath = flaggedOut ?? values[4];
  return Object.freeze({
    area: 'trace',
    action,
    kind,
    ...(values[3] ? { template: values[3] } : {}),
    ...(outPath ? { outPath } : {}),
  });
}
