import type { SpikeConfig } from './config.ts';
import type { SpikeRequest, SpikeResponse } from './types.ts';

export function targetedRequest(
  config: SpikeConfig,
  id: string,
  overrides: Partial<SpikeRequest> = {},
): SpikeRequest {
  return {
    version: 1,
    id,
    candidate: 'guest-simulator-framework-bridge',
    simulatorUdid: config.udid,
    state: 'warm',
    screen: 'list',
    limits: config.limits,
    ...overrides,
  };
}

export function missingResponse(id: string): SpikeResponse {
  return {
    version: 1,
    id,
    candidate: 'guest-simulator-framework-bridge',
    ok: false,
    failure: { kind: 'transport-failure', code: 'missing-response' },
    metrics: {
      requestBytes: 0,
      responseBytes: 0,
      nodeCount: 0,
      maxTraversalDepth: 0,
      cpuMs: null,
      memoryBytes: null,
      durationMs: 0,
    },
  };
}

export function usableTree(
  response: SpikeResponse,
  expectedGeneration?: string,
  expectedAnchor?: string,
): boolean {
  const acquisition = response.acquisition;
  if (!response.ok) return false;
  if (!acquisition || acquisition.nodes.length === 0) return false;
  return [
    matchesOptional(expectedGeneration, acquisition.targetGeneration),
    containsOptionalAnchor(expectedAnchor, acquisition.nodes),
  ].every(Boolean);
}

export function adapterOptions(config: SpikeConfig) {
  return { guestBridge: config.guestBridge, limits: config.limits };
}

function matchesOptional(expected: string | undefined, observed: string | null): boolean {
  return expected === undefined || expected === observed;
}

function containsOptionalAnchor(
  expected: string | undefined,
  nodes: NonNullable<SpikeResponse['acquisition']>['nodes'],
): boolean {
  if (expected === undefined) return true;
  return nodes.some((node) => node.label === expected || node.value === expected);
}
