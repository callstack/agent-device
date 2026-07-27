// Case-executing worker for the parser fuzz lane (#1414).
//
// The cases run off the main thread for one reason: a synchronous parser that never returns
// cannot be timed out from inside its own tick. The worker publishes the index of the case
// it is about to run into a SharedArrayBuffer; the runner watchdogs that counter and, when
// it stops advancing, knows exactly which input hung and can terminate the thread.

import { parentPort, workerData } from 'node:worker_threads';
import { checkCase, type FuzzFailure } from './invariant.ts';
import { getFuzzTarget } from './registry.ts';

export type FuzzWorkerData = {
  targetName: string;
  cases: string[];
  progress: SharedArrayBuffer;
};

export type FuzzWorkerMessage =
  | { kind: 'ready' }
  | { kind: 'failure'; failure: FuzzFailure }
  | { kind: 'done' };

const port = parentPort;
if (!port) throw new Error('scripts/fuzz/worker.ts must be run as a worker thread.');

const { targetName, cases, progress } = workerData as FuzzWorkerData;
const target = getFuzzTarget(targetName);
const cursor = new Int32Array(progress);

// Module loading (type stripping, parser imports) can outlast a per-case budget, so the
// watchdog only starts counting once the worker is about to run the first case.
port.postMessage({ kind: 'ready' } satisfies FuzzWorkerMessage);

// The batch-steps parser warns on deprecated step shapes; a fuzz run would emit thousands of
// those lines and bury the failure report.
const writeStderr = process.stderr.write.bind(process.stderr);
process.stderr.write = (() => true) as typeof process.stderr.write;

try {
  for (const [index, input] of cases.entries()) {
    Atomics.store(cursor, 0, index);
    const failure = checkCase(target, input);
    if (failure) port.postMessage({ kind: 'failure', failure } satisfies FuzzWorkerMessage);
  }
  Atomics.store(cursor, 0, cases.length);
} finally {
  process.stderr.write = writeStderr;
}

port.postMessage({ kind: 'done' } satisfies FuzzWorkerMessage);
