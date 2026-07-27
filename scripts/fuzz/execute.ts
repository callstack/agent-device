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
    // Set again when the worker reports ready: startup is not case time.
    let lastAdvance = Date.now();

    const finish = (result: FuzzFailure[]) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      void worker.terminate();
      resolve(result);
    };

    const watchdog = setInterval(() => {
      const index = Atomics.load(cursor, 0);
      if (index !== lastIndex) {
        lastIndex = index;
        lastAdvance = Date.now();
        return;
      }
      if (Date.now() - lastAdvance < caseTimeoutMs) return;
      failures.push({
        target: target.name,
        input: cases[index] ?? '',
        kind: 'hang',
        detail: `case ${index} did not finish within ${caseTimeoutMs}ms`,
      });
      finish(failures);
    }, 50);

    worker.on('message', (message: FuzzWorkerMessage) => {
      if (message.kind === 'ready') lastAdvance = Date.now();
      else if (message.kind === 'failure') failures.push(message.failure);
      else finish(failures);
    });
    worker.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      reject(error);
    });
    worker.on('exit', () => finish(failures));
  });
}
