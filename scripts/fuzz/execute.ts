// Case execution with hang detection for the parser fuzz lane (#1414).
//
// Cases run one at a time in a worker thread: a synchronous parser that never returns cannot be
// timed out from inside its own tick, so the budget is enforced from *another* thread, which can
// terminate the wedged one and attribute the stall to the exact input. Cases go over the wire
// individually (rather than as one batch) because fast-check drives the loop — it decides the next
// input, including the shrink candidates it derives from a failing one.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { FuzzFailure } from './invariant.ts';
import type { FuzzTarget } from './target-types.ts';
import type { FuzzWorkerData, FuzzWorkerMessage } from './worker.ts';

const WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.ts');

/** Bound on worker startup only; a per-case budget must never be charged for it. */
const STARTUP_BUDGET_MS = 60_000;

export type CaseRunner = {
  /** The failure this input violates the invariant with, or `null` when it holds. */
  run: (input: string) => Promise<FuzzFailure | null>;
  close: () => Promise<void>;
};

type Session = { worker: Worker; ready: Promise<void> };

/** A worker plus the promise that settles when it has finished importing the parsers. */
function startSession(targetName: string): Session {
  const workerData: FuzzWorkerData = { targetName };
  // Type stripping is requested explicitly rather than inherited: under Vitest the parent's
  // execArgv carries no such flag, and the worker is a plain `.ts` file Node must strip itself.
  // The warning is silenced because a restarted worker re-emits it — one per hang buries the report.
  const worker = new Worker(WORKER_PATH, {
    workerData,
    execArgv: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'],
  });
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`fuzz worker did not start within ${STARTUP_BUDGET_MS}ms`)),
      STARTUP_BUDGET_MS,
    );
    worker.once('message', (message: FuzzWorkerMessage) => {
      clearTimeout(timer);
      if (message.kind === 'ready') resolve();
      else reject(new Error(`unexpected first worker message: ${message.kind}`));
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return { worker, ready };
}

/**
 * Runs one case on a started worker. Startup is already awaited by the caller, so the budget below
 * covers parser time only — the reason a slow import can never be misreported as a parser hang.
 */
function runOnSession(
  session: Session,
  target: FuzzTarget,
  input: string,
  caseTimeoutMs: number,
): Promise<{ failure: FuzzFailure | null; hung: boolean }> {
  return new Promise((resolve, reject) => {
    const settle = (failure: FuzzFailure | null, hung: boolean) => {
      clearTimeout(timer);
      session.worker.off('message', onMessage);
      session.worker.off('error', onError);
      resolve({ failure, hung });
    };
    const onMessage = (message: FuzzWorkerMessage) => {
      if (message.kind === 'result') settle(message.failure, false);
    };
    const onError = (error: Error) => {
      clearTimeout(timer);
      session.worker.off('message', onMessage);
      reject(error);
    };
    const timer = setTimeout(() => {
      settle(
        {
          target: target.name,
          input,
          kind: 'hang',
          detail: `case did not finish within ${caseTimeoutMs}ms`,
        },
        true,
      );
    }, caseTimeoutMs);
    session.worker.on('message', onMessage);
    session.worker.once('error', onError);
    session.worker.postMessage({ kind: 'case', input });
  });
}

/**
 * A worker-backed runner for one target. A hang leaves the thread wedged in its own loop, so the
 * runner terminates it and starts a fresh one for the next case — otherwise a single hang would
 * silently turn every later case into a hang too.
 */
export async function createCaseRunner(
  target: FuzzTarget,
  caseTimeoutMs: number,
): Promise<CaseRunner> {
  let session = startSession(target.name);
  await session.ready;
  let closed = false;

  return {
    run: async (input) => {
      if (closed) throw new Error('fuzz case runner is closed');
      await session.ready;
      const { failure, hung } = await runOnSession(session, target, input, caseTimeoutMs);
      if (hung) {
        await session.worker.terminate();
        session = startSession(target.name);
        await session.ready;
      }
      return failure;
    },
    close: async () => {
      closed = true;
      await session.worker.terminate();
    },
  };
}

/** Runs a fixed list of cases (corpus replay, artifact replay, self-check) on one runner. */
export async function runCases(
  target: FuzzTarget,
  cases: readonly string[],
  caseTimeoutMs: number,
): Promise<FuzzFailure[]> {
  const runner = await createCaseRunner(target, caseTimeoutMs);
  try {
    const failures: FuzzFailure[] = [];
    for (const input of cases) {
      const failure = await runner.run(input);
      if (failure) failures.push(failure);
    }
    return failures;
  } finally {
    await runner.close();
  }
}
