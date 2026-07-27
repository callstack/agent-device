// Case execution with hang detection for the parser fuzz lane (#1414).
//
// Cases run in a worker thread that publishes the index of the case it is about to run; this
// module watchdogs that cursor, so a parser stuck in its own tick is reported as a `hang`
// against the exact input instead of wedging the lane.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { FuzzFailure } from './invariant.ts';
import type { FuzzTarget } from './target-types.ts';
import type { FuzzWorkerData, FuzzWorkerMessage } from './worker.ts';

const WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.ts');

/** Bound on worker startup only; a per-case budget must never be charged for it. */
const STARTUP_BUDGET_MS = 60_000;

export async function runTarget(
  target: FuzzTarget,
  cases: string[],
  caseTimeoutMs: number,
): Promise<FuzzFailure[]> {
  const progress = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const cursor = new Int32Array(progress);
  const workerData: FuzzWorkerData = { targetName: target.name, cases, progress };
  const worker = new Worker(WORKER_PATH, { workerData });
  const failures: FuzzFailure[] = [];

  return await new Promise<FuzzFailure[]>((resolve, reject) => {
    let settled = false;
    let lastIndex = -1;
    let lastAdvance = 0;
    let watchdog: NodeJS.Timeout | undefined;

    const finish = (result: FuzzFailure[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      if (watchdog) clearInterval(watchdog);
      void worker.terminate();
      resolve(result);
    };

    const reportHang = (detail: string, index: number) => {
      failures.push({ target: target.name, input: cases[index] ?? '', kind: 'hang', detail });
      finish(failures);
    };

    // Worker startup (thread spawn, type stripping, parser imports) is not case time and can
    // outlast a small per-case budget, so the per-case watchdog only starts once the worker says
    // it is about to run the first case. Startup gets its own generous budget instead, so an
    // import that wedges still cannot hang the lane forever.
    const startupTimer = setTimeout(
      () => reportHang(`worker did not start within ${STARTUP_BUDGET_MS}ms`, 0),
      STARTUP_BUDGET_MS,
    );

    const armCaseWatchdog = () => {
      clearTimeout(startupTimer);
      if (watchdog) return;
      lastAdvance = Date.now();
      watchdog = setInterval(() => {
        const index = Atomics.load(cursor, 0);
        if (index !== lastIndex) {
          lastIndex = index;
          lastAdvance = Date.now();
          return;
        }
        if (Date.now() - lastAdvance < caseTimeoutMs) return;
        reportHang(`case ${index} did not finish within ${caseTimeoutMs}ms`, index);
      }, 50);
    };

    worker.on('message', (message: FuzzWorkerMessage) => {
      if (message.kind === 'ready') armCaseWatchdog();
      else if (message.kind === 'failure') failures.push(message.failure);
      else finish(failures);
    });
    worker.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      if (watchdog) clearInterval(watchdog);
      reject(error);
    });
    worker.on('exit', () => finish(failures));
  });
}
