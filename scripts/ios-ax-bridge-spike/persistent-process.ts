import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { encodeFrame, DEFAULT_SPIKE_LIMITS } from './limits.ts';
import { failureResponse, parseSpikeResponse } from './protocol.ts';
import type { ResourceLimits, SpikeFailureKind, SpikeRequest, SpikeResponse } from './types.ts';

export type PersistentProcessSpec = Readonly<{
  file: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  limits?: ResourceLimits;
  beforeStart?: (requests: readonly SpikeRequest[]) => Promise<void>;
}>;

type EncodedRequest = Readonly<{
  request: SpikeRequest;
  bytes: number;
  line: string;
}>;

type PendingBatch = {
  requests: readonly SpikeRequest[];
  responses: Map<string, SpikeResponse>;
  responseBytes: number;
  resolve: (result: PersistentBatchResult) => void;
  timer: NodeJS.Timeout;
  abortCleanup: () => void;
};

export type PersistentBatchResult = Readonly<{
  responses: readonly SpikeResponse[];
  stderr: string;
}>;

export class PersistentFramedProcess {
  private readonly spec: PersistentProcessSpec;
  private readonly limits: ResourceLimits;
  private child?: ChildProcessWithoutNullStreams;
  private startPromise?: Promise<void>;
  private stdoutBuffer = Buffer.alloc(0);
  private stderr = '';
  private pending?: PendingBatch;
  private serial: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(spec: PersistentProcessSpec) {
    this.spec = spec;
    this.limits = spec.limits ?? DEFAULT_SPIKE_LIMITS;
  }

  acquireBatch(
    requests: readonly SpikeRequest[],
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<PersistentBatchResult> {
    const operation = this.serial.then(() => this.execute(requests, options));
    this.serial = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.finishPending('cancelled', 'process-closed', true);
    await this.serial;
    terminate(this.child);
    this.child = undefined;
  }

  private async execute(
    requests: readonly SpikeRequest[],
    options: Readonly<{ signal?: AbortSignal }>,
  ): Promise<PersistentBatchResult> {
    if (requests.length === 0) return { responses: [], stderr: '' };
    const encoded = requests.map((request) => ({ request, ...encodeFrame(request) }));
    if (encoded.some(({ bytes }) => bytes > this.limits.maxRequestBytes)) {
      return {
        responses: requests.map((request) =>
          failureResponse(request, { kind: 'transport-failure', code: 'request-limit-exceeded' }),
        ),
        stderr: '',
      };
    }
    if (options.signal?.aborted) return cancelledBatch(requests, encoded);
    try {
      await this.ensureChild(requests);
    } catch (error) {
      return {
        responses: requests.map((request) =>
          failureResponse(request, {
            kind: 'transport-failure',
            code: errorCode(error, 'persistent-process-start-failed'),
          }),
        ),
        stderr: this.takeStderr(),
      };
    }
    return await this.send(encoded, options.signal);
  }

  private async ensureChild(requests: readonly SpikeRequest[]): Promise<void> {
    if (this.closed) throw new Error('persistent-process-closed');
    if (this.child && !this.child.killed && this.child.exitCode === null) return;
    if (this.startPromise) return await this.startPromise;
    this.startPromise = this.start(requests).finally(() => {
      this.startPromise = undefined;
    });
    return await this.startPromise;
  }

  private async start(requests: readonly SpikeRequest[]): Promise<void> {
    await this.spec.beforeStart?.(requests);
    this.stdoutBuffer = Buffer.alloc(0);
    const child = spawn(this.spec.file, [...(this.spec.args ?? [])], {
      cwd: this.spec.cwd,
      env: { ...process.env, ...this.spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.on('data', (chunk: Buffer | string) => this.consumeStdout(chunk));
    child.stderr.on('data', (chunk: Buffer | string) => this.appendStderr(chunk));
    child.on('error', (error: NodeJS.ErrnoException) => {
      this.appendStderr(error.message);
      this.finishPending('transport-failure', error.code ?? 'persistent-process-error', false);
    });
    child.on('close', () => {
      if (this.child !== child) return;
      this.child = undefined;
      if (this.pending) this.finishPending('process-crash', 'persistent-process-exited', false);
    });
  }

  private send(
    encoded: readonly EncodedRequest[],
    signal: AbortSignal | undefined,
  ): Promise<PersistentBatchResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => this.finishPending('timeout', 'batch-duration-limit', true),
        this.limits.maxDurationMs * encoded.length,
      );
      const onAbort = (): void => this.finishPending('cancelled', 'abort-signal', true);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending = {
        requests: encoded.map(({ request }) => request),
        responses: new Map(),
        responseBytes: 0,
        resolve,
        timer,
        abortCleanup: () => signal?.removeEventListener('abort', onAbort),
      };
      for (const { line } of encoded) this.child?.stdin.write(line);
    });
  }

  private consumeStdout(chunk: Buffer | string): void {
    this.stdoutBuffer = Buffer.concat([
      this.stdoutBuffer,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
    ]);
    let newline = this.stdoutBuffer.indexOf(0x0a);
    while (newline >= 0) {
      const line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      this.consumeLine(line);
      if (!this.pending) return;
      newline = this.stdoutBuffer.indexOf(0x0a);
    }
  }

  private consumeLine(line: Buffer): void {
    if (line.length > this.limits.maxResponseBytes) {
      this.finishPending('malformed-tree', 'frame-limit-exceeded', true);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line.toString('utf8'));
    } catch {
      this.finishPending('malformed-tree', 'invalid-json', true);
      return;
    }
    const pending = this.pending;
    const request = pending?.requests.find((item) => item.id === readId(value));
    if (!pending || !request || pending.responses.has(request.id)) {
      this.finishPending('malformed-tree', 'response-id-invalid', true);
      return;
    }
    pending.responseBytes += line.length + 1;
    if (pending.responseBytes > this.limits.maxResponseBytes) {
      this.finishPending('malformed-tree', 'response-limit-exceeded', true);
      return;
    }
    pending.responses.set(request.id, parseSpikeResponse(value, request, line.length + 1));
    if (pending.responses.size === pending.requests.length) this.finishPending();
  }

  private finishPending(kind?: SpikeFailureKind, code?: string, terminateChild = false): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.abortCleanup();
    if (terminateChild) terminate(this.child);
    pending.resolve({
      responses: pending.requests.map(
        (request) =>
          pending.responses.get(request.id) ??
          failureResponse(request, {
            kind: kind ?? 'transport-failure',
            ...(code ? { code } : {}),
          }),
      ),
      stderr: this.takeStderr(),
    });
  }

  private appendStderr(chunk: Buffer | string): void {
    if (this.stderr.length >= 64 * 1024) return;
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    this.stderr += text.slice(0, 64 * 1024 - this.stderr.length);
  }

  private takeStderr(): string {
    const stderr = this.stderr;
    this.stderr = '';
    return stderr;
  }
}

function cancelledBatch(
  requests: readonly SpikeRequest[],
  encoded: readonly EncodedRequest[],
): PersistentBatchResult {
  return {
    responses: requests.map((request) =>
      failureResponse(
        request,
        { kind: 'cancelled', code: 'abort-signal' },
        { requestBytes: encoded.find((item) => item.request.id === request.id)?.bytes ?? 0 },
      ),
    ),
    stderr: '',
  };
}

function errorCode(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return fallback;
}

function readId(value: unknown): string | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const id = (value as Record<string, unknown>).id;
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}

function terminate(child: ChildProcessWithoutNullStreams | undefined): void {
  if (child && !child.killed) child.kill('SIGTERM');
}
