import { Worker } from 'node:worker_threads';
import { emitDiagnostic } from './diagnostics.ts';
import { AppError, toAppErrorCode } from '../kernel/errors.ts';
import { resolveInternalEntryModulePath } from './internal-entry.ts';
import { PNG } from './png-codec.ts';
import { decodePng } from './png.ts';
import {
  computeScreenshotDiffPixels,
  type ScreenshotDiffPixelsJob,
  type ScreenshotDiffPixelsResult,
} from './screenshot-diff-pixels.ts';
import {
  toBuffer,
  type PngWorkerJobFor,
  type PngWorkerJobKind,
  type PngWorkerJobResult,
  type PngWorkerJobResultFor,
  type PngWorkerResponse,
} from './png-worker-contract.ts';

/**
 * Async wrappers that offload CPU-heavy PNG decode/encode and screenshot
 * pixel diffing to a worker thread so daemon request handlers do not block
 * the shared event loop. When the worker entry cannot be resolved or fails
 * to start, every call transparently falls back to the in-process
 * synchronous implementation, producing byte-identical results.
 */

const PNG_WORKER_ENTRYPOINT = 'png-worker';

/** Worker-infrastructure failure: the generic runner falls back to the sync path. */
class PngWorkerUnavailableError extends Error {}

type PendingJob = {
  resolve: (result: PngWorkerJobResult) => void;
  reject: (error: Error) => void;
};

let worker: Worker | null = null;
let workerUnavailable = false;
let warnedWorkerUnavailable = false;
let nextJobId = 0;
const pendingJobs = new Map<number, PendingJob>();

/** Permanently degrades to the sync path and reports the reason once. */
function markWorkerUnavailable(reason: string): void {
  workerUnavailable = true;
  if (warnedWorkerUnavailable) return;
  warnedWorkerUnavailable = true;
  // Worker failures can surface outside a diagnostics scope (e.g. daemon
  // startup pre-warm), so pair the scoped diagnostic with a process warning.
  emitDiagnostic({ level: 'warn', phase: 'png_worker_unavailable', data: { reason } });
  process.emitWarning(
    `PNG worker unavailable, falling back to in-process PNG processing: ${reason}`,
  );
}

function handleWorkerMessage(message: PngWorkerResponse): void {
  const pending = pendingJobs.get(message.id);
  if (!pending) return;
  pendingJobs.delete(message.id);
  updateWorkerRef();
  if (message.ok) {
    pending.resolve(message.result);
  } else {
    pending.reject(
      new AppError(
        toAppErrorCode(message.error.code),
        message.error.message,
        message.error.details,
      ),
    );
  }
}

function handleWorkerFailure(failed: Worker, error: Error): void {
  if (worker !== failed) return;
  // Keep the failure handling conservative: after any worker-level error the
  // daemon permanently falls back to the in-process synchronous path.
  markWorkerUnavailable(error.message);
  worker = null;
  void failed.terminate().catch(() => {});
  rejectPendingJobs(new PngWorkerUnavailableError(`PNG worker failed: ${error.message}`));
}

function rejectPendingJobs(error: Error): void {
  const pending = [...pendingJobs.values()];
  pendingJobs.clear();
  for (const job of pending) {
    job.reject(error);
  }
}

function updateWorkerRef(): void {
  if (!worker) return;
  if (pendingJobs.size > 0) {
    worker.ref();
  } else {
    worker.unref();
  }
}

function obtainWorker(): Worker | null {
  if (workerUnavailable) return null;
  if (worker) return worker;
  const modulePath = resolveInternalEntryModulePath(import.meta.url, PNG_WORKER_ENTRYPOINT);
  if (!modulePath) {
    markWorkerUnavailable('worker entry module not found next to the current module');
    return null;
  }
  try {
    const created = new Worker(modulePath, {
      execArgv: modulePath.endsWith('.ts') ? ['--experimental-strip-types'] : [],
    });
    created.on('message', handleWorkerMessage);
    created.on('error', (error) => {
      handleWorkerFailure(created, error);
    });
    created.on('exit', (code) => {
      handleWorkerFailure(created, new Error(`PNG worker exited with code ${code}`));
    });
    created.unref();
    worker = created;
    return created;
  } catch (error) {
    markWorkerUnavailable(
      `failed to spawn worker: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/**
 * Sends one job to the worker. Rejects with `PngWorkerUnavailableError` for
 * worker-infrastructure failures (the single unavailability channel) and with
 * the reconstructed job `AppError` for job-level failures (e.g. corrupt PNG).
 */
function runWorkerJob<Kind extends PngWorkerJobKind>(
  job: PngWorkerJobFor<Kind>,
): Promise<PngWorkerJobResultFor<Kind>> {
  const activeWorker = obtainWorker();
  if (!activeWorker) {
    return Promise.reject(new PngWorkerUnavailableError('PNG worker is unavailable'));
  }
  nextJobId += 1;
  const id = nextJobId;
  return new Promise<PngWorkerJobResultFor<Kind>>((resolve, reject) => {
    pendingJobs.set(id, {
      // The worker answers each request id with the result of the same kind.
      resolve: resolve as (result: PngWorkerJobResult) => void,
      reject,
    });
    updateWorkerRef();
    try {
      activeWorker.postMessage({ ...job, id });
    } catch (error) {
      // Job-specific send failure (e.g. DataCloneError): fall back to the sync
      // path for this call without permanently disabling the worker.
      pendingJobs.delete(id);
      updateWorkerRef();
      reject(
        new PngWorkerUnavailableError(
          `failed to post job to PNG worker: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  });
}

/** Runs a job on the worker, falling back to `runSync` when it is unavailable. */
async function runPngJob<Kind extends PngWorkerJobKind>(
  job: PngWorkerJobFor<Kind>,
  runSync: () => PngWorkerJobResultFor<Kind>,
): Promise<PngWorkerJobResultFor<Kind>> {
  try {
    return await runWorkerJob(job);
  } catch (error) {
    if (error instanceof PngWorkerUnavailableError) return runSync();
    throw error;
  }
}

/** Daemon startup hook: spawns the worker before the first screenshot job. */
export function prewarmPngWorker(): void {
  obtainWorker();
}

/** Stops the worker thread (used by tests and shutdown); later calls respawn it. */
export async function terminatePngWorker(): Promise<void> {
  const active = worker;
  worker = null;
  rejectPendingJobs(new PngWorkerUnavailableError('PNG worker terminated'));
  if (active) {
    await active.terminate();
  }
}

export async function decodePngAsync(buffer: Buffer, label: string): Promise<PNG> {
  const result = await runPngJob({ kind: 'decode', png: buffer, label }, () => {
    const png = decodePng(buffer, label);
    return { kind: 'decode', width: png.width, height: png.height, data: png.data };
  });
  return new PNG({ width: result.width, height: result.height, data: toBuffer(result.data) });
}

export async function encodePngAsync(png: PNG): Promise<Buffer> {
  const result = await runPngJob(
    { kind: 'encode', width: png.width, height: png.height, data: png.data },
    () => ({ kind: 'encode', png: PNG.sync.write(png) }),
  );
  return toBuffer(result.png);
}

export async function computeScreenshotDiffPixelsAsync(
  job: ScreenshotDiffPixelsJob,
): Promise<ScreenshotDiffPixelsResult> {
  const { kind: _kind, ...result } = await runPngJob({ kind: 'diff-pixels', ...job }, () => ({
    kind: 'diff-pixels' as const,
    ...computeScreenshotDiffPixels(job),
  }));
  return { ...result, diffData: toBuffer(result.diffData) };
}
