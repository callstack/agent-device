// Case-executing worker for the parser fuzz lane (#1414).
//
// The cases run off the main thread for one reason: a synchronous parser that never returns
// cannot be timed out from inside its own tick. The worker answers one case at a time; the
// runner (scripts/fuzz/execute.ts) budgets the answer from the main thread and terminates this
// thread when a case stops answering, which is how a hang is attributed to an exact input.

import { parentPort, workerData } from 'node:worker_threads';
import { checkCase, type FuzzFailure } from './invariant.ts';
import { getFuzzTarget } from './registry.ts';

export type FuzzWorkerData = { targetName: string };

export type FuzzWorkerRequest = { kind: 'case'; input: string };

export type FuzzWorkerMessage = { kind: 'ready' } | { kind: 'result'; failure: FuzzFailure | null };

const port = parentPort;
if (!port) throw new Error('scripts/fuzz/worker.ts must be run as a worker thread.');

const { targetName } = workerData as FuzzWorkerData;
const target = getFuzzTarget(targetName);

// The batch-steps parser warns on deprecated step shapes; a fuzz run would emit thousands of
// those lines and bury the failure report.
process.stderr.write = (() => true) as typeof process.stderr.write;

port.on('message', (request: FuzzWorkerRequest) => {
  const failure = checkCase(target, request.input);
  port.postMessage({ kind: 'result', failure } satisfies FuzzWorkerMessage);
});

// Module loading (type stripping, parser imports) can outlast a per-case budget, so the runner
// only starts a case budget after this handshake.
port.postMessage({ kind: 'ready' } satisfies FuzzWorkerMessage);
