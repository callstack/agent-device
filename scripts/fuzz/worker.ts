// Case-executing worker process for the parser fuzz lane (#1414).
//
// Cases run out of process for two reasons. A synchronous parser that never returns cannot be
// timed out from inside its own tick, so the budget is enforced from outside — the runner
// (scripts/fuzz/execute.ts) kills this process when a case stops answering, which is how a hang
// is attributed to an exact input. And a case that faults the process it runs in cannot be
// caught at all: only a separate process keeps that fault off the caller, whose thread may be
// the unit lane's test runner (#2053).

import { checkCase, type FuzzFailure } from './invariant.ts';
import { getFuzzTarget } from './registry.ts';

export type FuzzWorkerRequest = { kind: 'case'; input: string };

export type FuzzWorkerMessage = { kind: 'ready' } | { kind: 'result'; failure: FuzzFailure | null };

const send = process.send?.bind(process);
if (!send) throw new Error('scripts/fuzz/worker.ts must be run as a forked child process.');

const target = getFuzzTarget(process.argv[2] ?? '');

// The batch-steps parser warns on deprecated step shapes; a fuzz run would emit thousands of
// those lines and bury the failure report. Only JavaScript writes go through here: a fatal
// fault writes to the descriptor itself, which is why the runner keeps this process's stderr
// piped rather than discarded.
process.stderr.write = (() => true) as typeof process.stderr.write;

process.on('message', (request: FuzzWorkerRequest) => {
  const failure = checkCase(target, request.input);
  send({ kind: 'result', failure } satisfies FuzzWorkerMessage);
});

// Module loading (type stripping, parser imports) can outlast a per-case budget, so the runner
// only starts a case budget after this handshake.
send({ kind: 'ready' } satisfies FuzzWorkerMessage);
