import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { GuestConnection, GuestConnectionError, processAlive } from './guest-connection.ts';
import { processUsageDelta } from './guest-process-metrics.ts';
import {
  acquisitionFromEnvelope,
  encodeGuestFrame,
  failureFromEnvelope,
  guestDescribeRequest,
  GuestWireError,
  isTargetNotReady,
  type GuestEnvelope,
} from './guest-wire.ts';
import { DEFAULT_SPIKE_LIMITS, validateRawAcquisition } from './limits.ts';
import { failureResponse } from './protocol.ts';
import type { AcquisitionAdapter, AdapterOptions } from './adapter.ts';
import type { ResourceLimits, SpikeFailure, SpikeRequest, SpikeResponse } from './types.ts';

const CANDIDATE = 'guest-simulator-framework-bridge' as const;
const TARGET_NOT_READY_RETRY_MS = 150;
const TARGET_NOT_READY_RETRIES = 2;

export function createGuestSimulatorFrameworkBridgeAdapter(
  options: AdapterOptions,
): AcquisitionAdapter {
  const limits = options.limits ?? DEFAULT_SPIKE_LIMITS;
  if (!options.guestBridge || !fs.existsSync(options.guestBridge)) {
    return unavailableAdapter('guest-tool-unavailable');
  }
  const session = new GuestSession(options.guestBridge, limits);
  return {
    candidate: CANDIDATE,
    acquireBatch: (requests, acquireOptions) => session.acquireBatch(requests, acquireOptions),
    close: () => session.close(),
    evidence: {
      terminateReaderOnNextBatch: () => session.killGuestOnNextRequestForEvidence(),
    },
  };
}

function unavailableAdapter(code: string): AcquisitionAdapter {
  return {
    candidate: CANDIDATE,
    async acquireBatch(requests) {
      return {
        responses: requests.map((request) =>
          failureResponse(request, { kind: 'unsupported-mechanism', code }),
        ),
        stderr: '',
      };
    },
  };
}

class GuestSession {
  private readonly connection: GuestConnection;
  private readonly limits: ResourceLimits;
  private closed = false;
  private serial: Promise<unknown> = Promise.resolve();

  constructor(bridgePath: string, limits: ResourceLimits) {
    this.limits = limits;
    this.connection = new GuestConnection(bridgePath, limits.maxResponseBytes);
  }

  acquireBatch(
    requests: readonly SpikeRequest[],
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<{ responses: readonly SpikeResponse[]; stderr: string }> {
    const operation = this.serial.then(() => this.execute(requests, options.signal));
    this.serial = operation.catch(() => undefined);
    return operation;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.connection.close();
  }

  killGuestOnNextRequestForEvidence(): void {
    this.connection.killOnNextRequest();
  }

  private async execute(
    requests: readonly SpikeRequest[],
    signal: AbortSignal | undefined,
  ): Promise<{ responses: readonly SpikeResponse[]; stderr: string }> {
    const responses: SpikeResponse[] = [];
    for (const request of requests) {
      const deadline = performance.now() + request.limits.maxDurationMs;
      responses.push(await this.acquire(request, deadline, signal));
    }
    return { responses, stderr: this.connection.takeLog() };
  }

  private async acquire(
    request: SpikeRequest,
    deadline: number,
    signal: AbortSignal | undefined,
  ): Promise<SpikeResponse> {
    const started = performance.now();
    const frame = encodeGuestFrame(guestDescribeRequest(request, request.limits));
    if (frame.length > request.limits.maxRequestBytes) {
      return failureResponse(request, {
        kind: 'transport-failure',
        code: 'request-limit-exceeded',
      });
    }
    try {
      return await this.acquireConnected(request, frame, deadline, started, signal);
    } catch (error) {
      return failedGuestRequest(request, frame.length, started, error);
    }
  }

  private async acquireConnected(
    request: SpikeRequest,
    frame: Buffer,
    deadline: number,
    started: number,
    signal: AbortSignal | undefined,
  ): Promise<SpikeResponse> {
    assertRequestActive(signal, this.closed);
    const wasConnected = await this.connection.ensureConnected(
      request.simulatorUdid,
      deadline,
      signal,
    );
    const before = wasConnected ? this.connection.processSample() : undefined;
    const { envelope, responseBytes } = await this.readWithReadinessRetry(frame, deadline, signal);
    const resources = processUsageDelta(before, this.connection.processSample());
    return this.responseFor(request, envelope, {
      requestBytes: frame.length,
      responseBytes,
      durationMs: performance.now() - started,
      cpuMs: resources?.cpuMs ?? null,
      memoryBytes: resources?.memoryBytes ?? null,
    });
  }

  private async readWithReadinessRetry(
    frame: Buffer,
    deadline: number,
    signal: AbortSignal | undefined,
  ): Promise<{ envelope: GuestEnvelope; responseBytes: number }> {
    let attempt = await this.connection.roundTrip(frame, deadline, signal);
    for (let retry = 0; retry < TARGET_NOT_READY_RETRIES; retry += 1) {
      if (attempt.envelope.ok === true || !isTargetNotReady(attempt.envelope)) break;
      if (performance.now() + TARGET_NOT_READY_RETRY_MS * 2 > deadline) break;
      await sleep(TARGET_NOT_READY_RETRY_MS);
      attempt = await this.connection.roundTrip(frame, deadline, signal);
    }
    return attempt;
  }

  private responseFor(
    request: SpikeRequest,
    envelope: GuestEnvelope,
    metrics: {
      requestBytes: number;
      responseBytes: number;
      durationMs: number;
      cpuMs: number | null;
      memoryBytes: number | null;
    },
  ): SpikeResponse {
    if (envelope.ok !== true) {
      return failureResponse(
        request,
        failureFromEnvelope(envelope, request, processAlive),
        metrics,
      );
    }
    const parsed = acquisitionFromEnvelope(envelope, request, request.limits);
    if ('kind' in parsed) return failureResponse(request, parsed, metrics);
    const validated = validateRawAcquisition(parsed.acquisition, request.limits);
    if (!validated.ok) {
      return failureResponse(request, { kind: 'malformed-tree', code: validated.code }, metrics);
    }
    const resourceFailure = resourceLimitFailure(metrics, request.limits);
    if (resourceFailure) return failureResponse(request, resourceFailure, metrics);
    return {
      version: 1,
      id: request.id,
      candidate: request.candidate,
      ok: true,
      acquisition: parsed.acquisition,
      metrics: {
        ...metrics,
        nodeCount: parsed.acquisition.nodes.length,
        maxTraversalDepth: validated.maxTraversalDepth,
      },
    };
  }
}

function asGuestError(error: unknown): GuestConnectionError {
  if (error instanceof GuestConnectionError) return error;
  if (error instanceof GuestWireError) return new GuestConnectionError(error.kind, error.code);
  return new GuestConnectionError('transport-failure', 'guest-unexpected-error');
}

function assertRequestActive(signal: AbortSignal | undefined, closed: boolean): void {
  if (signal?.aborted) throw new GuestConnectionError('cancelled', 'abort-signal');
  if (closed) throw new GuestConnectionError('transport-failure', 'guest-adapter-closed');
}

function failedGuestRequest(
  request: SpikeRequest,
  requestBytes: number,
  started: number,
  error: unknown,
): SpikeResponse {
  const guestError = asGuestError(error);
  return failureResponse(
    request,
    { kind: guestError.kind, code: guestError.code },
    { requestBytes, durationMs: performance.now() - started },
  );
}

function resourceLimitFailure(
  metrics: { cpuMs: number | null; memoryBytes: number | null },
  limits: ResourceLimits,
): SpikeFailure | undefined {
  if (metrics.cpuMs !== null && metrics.cpuMs > limits.maxCpuMs) {
    return { kind: 'transport-failure', code: 'cpu-limit-exceeded' };
  }
  if (metrics.memoryBytes !== null && metrics.memoryBytes > limits.maxMemoryBytes) {
    return { kind: 'transport-failure', code: 'memory-limit-exceeded' };
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
