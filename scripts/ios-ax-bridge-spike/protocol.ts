import type { ResourceMetrics, SpikeFailure, SpikeRequest, SpikeResponse } from './types.ts';

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
