import { performance } from 'node:perf_hooks';
import {
  classifyFailure,
  snapshotFixture,
  type CliContext,
  type CliResult,
} from '../ios-snapshot-benchmark/command.ts';
import { DEFAULT_SPIKE_LIMITS, validateRawAcquisition } from './limits.ts';
import { failureResponse } from './protocol.ts';
import type {
  CandidateId,
  RawAcquiredNode,
  ResourceLimits,
  SpikeRequest,
  SpikeResponse,
} from './types.ts';

export type AcquisitionAdapter = Readonly<{
  candidate: CandidateId;
  acquireBatch(
    requests: readonly SpikeRequest[],
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AcquisitionBatchResult>;
  close?: () => Promise<void>;
}>;

export type AcquisitionBatchResult = Readonly<{
  responses: readonly SpikeResponse[];
  stderr: string;
}>;

export type AdapterOptions = Readonly<{
  repoRoot: string;
  limits?: ResourceLimits;
  guestCompanion?: string;
  guestPython?: string;
  guestSitePackages?: string;
}>;

export function createXCTestControlAdapter(
  contextFor: (request: SpikeRequest) => CliContext,
): AcquisitionAdapter {
  return {
    candidate: 'xctest-control',
    async acquireBatch(requests) {
      return {
        responses: requests.map((request) => {
          const started = performance.now();
          return controlResponse(
            request,
            snapshotFixture(contextFor(request)),
            performance.now() - started,
          );
        }),
        stderr: '',
      };
    },
  };
}

function controlResponse(
  request: SpikeRequest,
  result: CliResult,
  durationMs: number,
): SpikeResponse {
  const snapshot = readControlSnapshot(result.payload);
  return result.ok && snapshot
    ? successfulControlResponse(request, snapshot, result, durationMs)
    : failedControlResponse(request, result);
}

function successfulControlResponse(
  request: SpikeRequest,
  snapshot: ControlSnapshot,
  result: CliResult,
  durationMs: number,
): SpikeResponse {
  const acquisition = {
    targetId: `simulator:${request.simulatorUdid}`,
    targetGeneration: snapshot.targetGeneration,
    nodes: snapshot.nodes,
    viewport: snapshot.viewport,
    truncated: snapshot.truncated,
    residue: [{ kind: 'missing-viewport', reason: 'not-provided' }],
  } as const;
  const validated = validateRawAcquisition(acquisition, request.limits);
  if (!validated.ok) {
    return failureResponse(request, { kind: 'malformed-tree', code: validated.code });
  }
  return {
    version: 1,
    id: request.id,
    candidate: request.candidate,
    ok: true,
    acquisition,
    metrics: {
      requestBytes: 0,
      responseBytes: Buffer.byteLength(result.stdout),
      nodeCount: acquisition.nodes.length,
      maxTraversalDepth: validated.maxTraversalDepth,
      cpuMs: null,
      memoryBytes: null,
      durationMs,
    },
  };
}

function failedControlResponse(request: SpikeRequest, result: CliResult): SpikeResponse {
  const failure = classifyFailure(result.payload, result);
  return failureResponse(
    request,
    {
      kind: controlFailureKind(failure.category),
      ...(failure.code ? { code: failure.code } : {}),
    },
    {
      responseBytes: Buffer.byteLength(result.stdout),
      durationMs: result.wallClockMs,
    },
  );
}

function controlFailureKind(
  category: string,
): 'timeout' | 'stale-generation' | 'transport-failure' {
  if (category === 'timeout') return 'timeout';
  if (category === 'stale-generation') return 'stale-generation';
  return 'transport-failure';
}

export type ControlSnapshot = Readonly<{
  nodes: RawAcquiredNode[];
  targetGeneration: string | null;
  truncated: boolean;
  viewport: { kind: 'missing'; reason: 'not-provided' };
}>;

export function readControlSnapshot(value: unknown): ControlSnapshot | undefined {
  const snapshot = findSnapshotRecord(value);
  if (!snapshot || !Array.isArray(snapshot.nodes)) return undefined;
  const nodes = snapshot.nodes.flatMap((rawNode) => toRawNode(rawNode));
  return {
    nodes,
    targetGeneration: readGeneration(snapshot),
    truncated: snapshot.truncated === true,
    viewport: { kind: 'missing', reason: 'not-provided' },
  };
}

function findSnapshotRecord(value: unknown): Record<string, unknown> | undefined {
  const root = record(value);
  return root ? snapshotFromRoot(root) : undefined;
}

function snapshotFromRoot(root: Record<string, unknown>): Record<string, unknown> | undefined {
  const stepData = firstBatchStep(record(root.data));
  return snapshotFromStep(stepData);
}

function snapshotFromStep(
  stepData: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!stepData) return undefined;
  return record(stepData.snapshot) ?? stepData;
}

function firstBatchStep(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const results = data.results;
  return Array.isArray(results) ? firstResultData(results, data) : data;
}

function firstResultData(
  results: readonly unknown[],
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  const first = record(results[0]);
  return record(first?.data) ?? fallback;
}

function toRawNode(value: unknown): RawAcquiredNode[] {
  const node = record(value);
  if (!node || typeof node.index !== 'number') return [];
  return [
    {
      id: String(node.index),
      ...rawNodeFacts(node),
    },
  ];
}

function rawNodeFacts(node: Record<string, unknown>): Partial<RawAcquiredNode> {
  return {
    ...optionalParent(node.parentIndex),
    ...optionalString(node, 'type'),
    ...optionalString(node, 'role'),
    ...optionalString(node, 'subrole'),
    ...optionalString(node, 'label'),
    ...optionalString(node, 'value'),
    ...optionalString(node, 'identifier'),
    ...optionalRect(node.rect),
    ...optionalBoolean(node, 'enabled'),
    ...optionalBoolean(node, 'selected'),
    ...optionalBoolean(node, 'focused'),
  };
}

function optionalParent(value: unknown): Partial<RawAcquiredNode> {
  return typeof value === 'number' ? { parentId: String(value) } : {};
}

function readGeneration(snapshot: Record<string, unknown>): string | null {
  const value = snapshot.refsGeneration ?? snapshot.targetGeneration;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function optionalString(
  recordValue: Record<string, unknown>,
  key: 'type' | 'role' | 'subrole' | 'label' | 'value' | 'identifier',
): Partial<RawAcquiredNode> {
  return typeof recordValue[key] === 'string' ? { [key]: recordValue[key] } : {};
}

function optionalBoolean(
  recordValue: Record<string, unknown>,
  key: 'enabled' | 'selected' | 'focused',
): Partial<RawAcquiredNode> {
  return typeof recordValue[key] === 'boolean' ? { [key]: recordValue[key] } : {};
}

function optionalRect(value: unknown): Partial<RawAcquiredNode> {
  const rect = record(value);
  if (!rect || !['x', 'y', 'width', 'height'].every((key) => typeof rect[key] === 'number')) {
    return {};
  }
  return {
    frame: {
      x: rect.x as number,
      y: rect.y as number,
      width: rect.width as number,
      height: rect.height as number,
    },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
