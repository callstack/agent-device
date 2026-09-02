import { validateRawAcquisition } from './limits.ts';
import type {
  ResourceMetrics,
  SpikeFailure,
  SpikeFailureKind,
  SpikeRequest,
  SpikeResponse,
} from './types.ts';
import type { FirstTreeStatus } from '../ios-snapshot-benchmark/types.ts';

const FAILURE_KINDS: ReadonlySet<SpikeFailureKind> = new Set([
  'unsupported-mechanism',
  'malformed-tree',
  'stale-generation',
  'timeout',
  'cancelled',
  'process-crash',
  'transport-failure',
]);

export function parseSpikeResponse(
  value: unknown,
  request: SpikeRequest,
  responseBytes: number,
): SpikeResponse {
  if (!isRecord(value)) return malformedResponse(request, 'response-not-object', responseBytes);
  if (value.version !== 1) return malformedResponse(request, 'protocol-version', responseBytes);
  if (value.id !== request.id)
    return malformedResponse(request, 'response-id-mismatch', responseBytes);
  if (value.candidate !== request.candidate) {
    return malformedResponse(request, 'response-candidate-mismatch', responseBytes);
  }
  const metrics = parseMetrics(value.metrics, responseBytes);
  if (!metrics) return malformedResponse(request, 'metrics-invalid', responseBytes);

  if (value.ok === true) {
    const tree = validateRawAcquisition(value.acquisition, request.limits);
    if (!tree.ok) return malformedResponse(request, tree.code, responseBytes, metrics);
    return {
      version: 1,
      id: request.id,
      candidate: request.candidate,
      ok: true,
      acquisition: tree.acquisition,
      metrics: {
        ...metrics,
        nodeCount: tree.acquisition.nodes.length,
        maxTraversalDepth: tree.maxTraversalDepth,
      },
    };
  }

  const failure = parseFailure(value.failure);
  if (!failure) return malformedResponse(request, 'failure-invalid', responseBytes, metrics);
  return {
    version: 1,
    id: request.id,
    candidate: request.candidate,
    ok: false,
    failure,
    metrics,
  };
}

export function failureResponse(
  request: SpikeRequest,
  failure: SpikeFailure,
  metrics: Partial<ResourceMetrics> = {},
): SpikeResponse {
  return {
    version: 1,
    id: request.id,
    candidate: request.candidate,
    ok: false,
    failure,
    metrics: {
      requestBytes: metrics.requestBytes ?? 0,
      responseBytes: metrics.responseBytes ?? 0,
      nodeCount: metrics.nodeCount ?? 0,
      maxTraversalDepth: metrics.maxTraversalDepth ?? 0,
      cpuMs: metrics.cpuMs ?? null,
      memoryBytes: metrics.memoryBytes ?? null,
      durationMs: metrics.durationMs ?? 0,
    },
  };
}

export function firstTreeStatus(response: SpikeResponse): FirstTreeStatus {
  if (response.ok) return response.acquisition?.nodes.length ? 'readable' : 'empty';
  if (response.failure?.kind === 'unsupported-mechanism') return 'unreadable';
  return 'not-observed';
}

export function readResponseId(value: unknown): string | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const id = (value as Record<string, unknown>).id;
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}

function malformedResponse(
  request: SpikeRequest,
  code: string,
  responseBytes: number,
  metrics?: ResourceMetrics,
): SpikeResponse {
  return failureResponse(
    request,
    { kind: 'malformed-tree', code },
    {
      ...(metrics ?? {}),
      responseBytes,
    },
  );
}

function parseMetrics(value: unknown, responseBytes: number): ResourceMetrics | undefined {
  if (!isRecord(value)) return undefined;
  const requestBytes = finiteNonNegative(value.requestBytes);
  const nodeCount = finiteNonNegative(value.nodeCount);
  const maxTraversalDepth = finiteNonNegative(value.maxTraversalDepth);
  const durationMs = finiteNonNegative(value.durationMs);
  if (
    requestBytes === undefined ||
    nodeCount === undefined ||
    maxTraversalDepth === undefined ||
    durationMs === undefined
  ) {
    return undefined;
  }
  const cpuMs = nullableFiniteNonNegative(value.cpuMs);
  const memoryBytes = nullableFiniteNonNegative(value.memoryBytes);
  if (cpuMs === 'invalid' || memoryBytes === 'invalid') return undefined;
  return {
    requestBytes,
    responseBytes,
    nodeCount,
    maxTraversalDepth,
    cpuMs,
    memoryBytes,
    durationMs,
  };
}

function parseFailure(value: unknown): SpikeFailure | undefined {
  const record = asFailureRecord(value);
  if (!record) return undefined;
  const kind = readFailureKind(record.kind);
  if (!kind) return undefined;
  const code = optionalFailureString(record, 'code');
  const expected = optionalFailureString(record, 'expectedTargetGeneration');
  const observed = optionalFailureString(record, 'observedTargetGeneration');
  if (!code.valid || !expected.valid || !observed.valid) return undefined;
  return {
    kind,
    ...(code.value === undefined ? {} : { code: code.value }),
    ...(expected.value === undefined ? {} : { expectedTargetGeneration: expected.value }),
    ...(observed.value === undefined ? {} : { observedTargetGeneration: observed.value }),
  };
}

function asFailureRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) && typeof value.kind === 'string' ? value : undefined;
}

function readFailureKind(value: unknown): SpikeFailureKind | undefined {
  return typeof value === 'string' && FAILURE_KINDS.has(value as SpikeFailureKind)
    ? (value as SpikeFailureKind)
    : undefined;
}

function optionalFailureString(
  value: Record<string, unknown>,
  key: 'code' | 'expectedTargetGeneration' | 'observedTargetGeneration',
): { valid: boolean; value?: string } {
  if (value[key] === undefined) return { valid: true };
  return typeof value[key] === 'string'
    ? { valid: true, value: value[key] as string }
    : { valid: false };
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nullableFiniteNonNegative(value: unknown): number | null | 'invalid' {
  if (value === null) return null;
  const number = finiteNonNegative(value);
  return number === undefined ? 'invalid' : number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
