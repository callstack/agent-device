import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { encodeFrame, DEFAULT_SPIKE_LIMITS } from './limits.ts';
import { failureResponse, parseSpikeResponse } from './protocol.ts';
import type { ResourceLimits, SpikeFailureKind, SpikeRequest, SpikeResponse } from './types.ts';

export type FramedProcessSpec = Readonly<{
  file: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}>;

export type FramedBatchResult = Readonly<{
  responses: readonly SpikeResponse[];
  stderr: string;
}>;

export async function runFramedBatch(
  spec: FramedProcessSpec,
  requests: readonly SpikeRequest[],
  options: Readonly<{ signal?: AbortSignal; limits?: ResourceLimits }> = {},
): Promise<FramedBatchResult> {
  const limits = options.limits ?? DEFAULT_SPIKE_LIMITS;
  const encodedRequests = requests.map((request) => ({
    request,
    ...encodeFrame(request),
  }));
  const oversized = encodedRequests.find(({ bytes }) => bytes > limits.maxRequestBytes);
  if (oversized) {
    return {
      responses: requests.map((request) =>
        failureResponse(
          request,
          { kind: 'transport-failure', code: 'request-limit-exceeded' },
          {
            requestBytes:
              encodedRequests.find((item) => item.request.id === request.id)?.bytes ?? 0,
          },
        ),
      ),
      stderr: '',
    };
  }
  if (requests.length === 0) return { responses: [], stderr: '' };
  if (options.signal?.aborted) return cancelledBatch(requests, encodedRequests);

  return new Promise((resolve) => {
    const child = spawn(spec.file, [...(spec.args ?? [])], {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const responses = new Map<string, SpikeResponse>();
    const requestById = new Map(requests.map((request) => [request.id, request]));
    let stdoutBuffer = Buffer.alloc(0);
    let stdoutBytes = 0;
    let stderr = '';
    let settled = false;
    const batchDurationMs = limits.maxDurationMs * requests.length;
    const timer = setTimeout(() => finish('timeout', 'batch-duration-limit'), batchDurationMs);

    const finish = (kind?: SpikeFailureKind, code?: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (kind) {
        for (const request of requests) {
          if (!responses.has(request.id)) {
            responses.set(
              request.id,
              failureResponse(
                request,
                { kind, ...(code ? { code } : {}) },
                {
                  requestBytes: requestBytesFor(request, encodedRequests),
                  responseBytes: stdoutBytes,
                },
              ),
            );
          }
        }
      }
      if (kind === 'timeout' || kind === 'cancelled') terminate(child);
      resolve({
        responses: requests.map(
          (request) =>
            responses.get(request.id) ??
            failureResponse(
              request,
              { kind: 'transport-failure', code: 'missing-response' },
              {
                requestBytes: requestBytesFor(request, encodedRequests),
                responseBytes: stdoutBytes,
              },
            ),
        ),
        stderr,
      });
    };
    const onAbort = (): void => finish('cancelled', 'abort-signal');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += data.length;
      if (stdoutBytes > limits.maxResponseBytes) {
        finish('malformed-tree', 'response-limit-exceeded');
        return;
      }
      stdoutBuffer = Buffer.concat([stdoutBuffer, data]);
      consumeLines();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      if (stderr.length >= 64 * 1024) return;
      stderr += (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk).slice(
        0,
        64 * 1024 - stderr.length,
      );
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish('transport-failure', error.code ?? 'spawn-error');
    });
    child.on('close', (code) => {
      if (settled) return;
      consumeLines(true);
      if (settled) return;
      if (code !== 0) {
        finish('process-crash', `exit-${code ?? 'unknown'}`);
        return;
      }
      if (responses.size !== requests.length) {
        finish('transport-failure', 'missing-response');
        return;
      }
      finish();
    });
    child.stdin.on('error', () => finish('transport-failure', 'stdin-error'));
    child.stdin.end(encodedRequests.map(({ line }) => line).join(''));

    function consumeLines(final = false): void {
      let newline = stdoutBuffer.indexOf(0x0a);
      while (newline >= 0) {
        const line = stdoutBuffer.subarray(0, newline);
        stdoutBuffer = stdoutBuffer.subarray(newline + 1);
        consumeLine(line);
        if (settled) return;
        newline = stdoutBuffer.indexOf(0x0a);
      }
      if (final && stdoutBuffer.length > 0) consumeLine(stdoutBuffer);
    }

    function consumeLine(line: Buffer): void {
      const text = line.toString('utf8').trim();
      if (text.length === 0) return;
      if (line.length > limits.maxResponseBytes) {
        finish('malformed-tree', 'frame-limit-exceeded');
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        finish('malformed-tree', 'invalid-json');
        return;
      }
      const id = readId(value);
      const request = id ? requestById.get(id) : undefined;
      if (!request || responses.has(request.id)) {
        finish('malformed-tree', 'response-id-invalid');
        return;
      }
      responses.set(request.id, parseSpikeResponse(value, request, line.length + 1));
    }
  });
}

function cancelledBatch(
  requests: readonly SpikeRequest[],
  encodedRequests: readonly Readonly<{ request: SpikeRequest; bytes: number; line: string }>[],
): FramedBatchResult {
  return {
    responses: requests.map((request) =>
      failureResponse(
        request,
        { kind: 'cancelled', code: 'abort-signal' },
        {
          requestBytes: requestBytesFor(request, encodedRequests),
        },
      ),
    ),
    stderr: '',
  };
}

function requestBytesFor(
  request: SpikeRequest,
  encodedRequests: readonly Readonly<{ request: SpikeRequest; bytes: number; line: string }>[],
): number {
  return encodedRequests.find((item) => item.request.id === request.id)?.bytes ?? 0;
}

function readId(value: unknown): string | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const id = (value as Record<string, unknown>).id;
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}

function terminate(child: ChildProcess): void {
  if (!child.killed) child.kill('SIGTERM');
}
