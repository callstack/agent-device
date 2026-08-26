// Case execution with hang and crash detection for the parser fuzz lane (#1414).
//
// Cases run one at a time in a child process, and the budget is enforced from the parent. Two
// faults a case can produce cannot be observed from inside the context running it: a synchronous
// parser that never returns cannot be timed out from its own tick, and a parser that faults the
// process — a native crash, an out-of-memory abort — leaves no stack to catch. Both are
// attributed here, to the exact input, by watching a process the parent can outlive.
//
// It is a process rather than a worker thread because a thread cannot contain the second fault:
// a fault in a worker thread takes its whole process down, and that process is the caller's —
// for the unit-lane replay, the Vitest worker running the test file, which then dies with no
// test, file, or case named (#2053). Cases go over the wire individually (rather than as one
// batch) because fast-check drives the loop — it decides the next input, including the shrink
// candidates it derives from a failing one.

import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FuzzFailure } from './invariant.ts';
import type { FuzzTarget } from './target-types.ts';
import type { FuzzWorkerMessage } from './worker.ts';

const WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.ts');

/** Bound on worker startup only; a per-case budget must never be charged for it. */
const STARTUP_BUDGET_MS = 60_000;

/** How much of a dead worker's output a crash failure quotes. Enough for a V8 fatal banner. */
const DEATH_OUTPUT_LIMIT = 2_000;

export type CaseRunner = {
  /** The failure this input violates the invariant with, or `null` when it holds. */
  run: (input: string) => Promise<FuzzFailure | null>;
  close: () => Promise<void>;
};

/** A started worker: it has answered the handshake, so a budget may be charged to it. */
type Session = {
  child: ChildProcess;
  /**
   * How the process died, or `null` while it is alive — the death certificate a crash failure
   * quotes. A reader rather than a field because the session's own listeners write it.
   */
  death: () => string | null;
};

/**
 * Everything a worker can do next, and all either wait below has to classify: answer, die, or
 * stay silent for the whole budget. The handshake and a case are the same wait against different
 * budgets, so they share one primitive and differ only in what they make of its three outcomes.
 */
type WorkerOutcome =
  | { kind: 'message'; message: FuzzWorkerMessage }
  | { kind: 'death' }
  | { kind: 'silence' };

function awaitWorker(child: ChildProcess, budgetMs: number): Promise<WorkerOutcome> {
  return new Promise((resolve) => {
    const finish = (outcome: WorkerOutcome) => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('close', onDeath);
      child.off('error', onDeath);
      resolve(outcome);
    };
    const onMessage = (message: FuzzWorkerMessage) => finish({ kind: 'message', message });
    const onDeath = () => finish({ kind: 'death' });
    const timer = setTimeout(() => finish({ kind: 'silence' }), budgetMs);
    child.once('message', onMessage);
    child.once('close', onDeath);
    child.once('error', onDeath);
  });
}

function describeDeath(code: number | null, signal: NodeJS.Signals | null, output: string): string {
  const how = signal === null ? `exit code ${code}` : `signal ${signal}`;
  const tail = output.trim();
  return tail === '' ? how : `${how}: ${tail}`;
}

/** Why a started worker is unusable, or `null` when it handed back the handshake. */
function startupRefusal(outcome: WorkerOutcome, death: string | null): string | null {
  if (outcome.kind === 'silence') return `fuzz worker did not start within ${STARTUP_BUDGET_MS}ms`;
  if (outcome.kind === 'death') return `fuzz worker died before it was ready (${death})`;
  if (outcome.message.kind !== 'ready') {
    return `unexpected first worker message: ${outcome.message.kind}`;
  }
  return null;
}

/** Starts a worker and resolves once it has finished importing the parsers. */
async function startSession(targetName: string): Promise<Session> {
  const child = fork(WORKER_PATH, [targetName], {
    // Type stripping is requested explicitly rather than inherited: under Vitest the parent's
    // execArgv carries no such flag, and the worker is a plain `.ts` file Node must strip itself.
    // The warning is silenced because a restarted worker re-emits it — one per hang buries the report.
    execArgv: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'],
    // stderr is piped rather than inherited so a fatal fault — which writes to the descriptor and
    // so escapes the worker's own silencing — is quoted in the failure instead of the lane's log.
    stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
  });
  let death: string | null = null;
  let output = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    output = (output + chunk).slice(-DEATH_OUTPUT_LIMIT);
  });
  // A ChildProcess with no `error` listener raises the error at the process, which is the fault
  // this module exists to keep off the caller. The message is evidence rather than the
  // certificate — `close` is the certificate whenever the process ran at all, and quotes this
  // tail — so the fallback below only stands for a worker that could not be spawned, the one
  // case where `close` never comes.
  child.on('error', (error) => {
    output = `${output}${error.message}\n`.slice(-DEATH_OUTPUT_LIMIT);
    death ??= `spawn failed: ${error.message}`;
  });
  // `close` rather than `exit`: it fires once the piped stderr has drained too, so the death is
  // recorded with the output that explains it.
  child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
    death = describeDeath(code, signal, output);
  });
  const session: Session = { child, death: () => death };
  const outcome = await awaitWorker(child, STARTUP_BUDGET_MS);
  const refusal = startupRefusal(outcome, session.death());
  if (refusal === null) return session;
  // Every refusing path ends the worker, including the silent one — a worker still importing
  // holds the channel open, and nothing else would ever come back for it.
  await endSession(session);
  throw new Error(refusal);
}

/** Ends a worker process, and resolves once it is gone. Already-dead sessions are a no-op. */
async function endSession(session: Session): Promise<void> {
  if (session.death() !== null) return;
  const gone = new Promise<void>((resolve) => session.child.once('close', () => resolve()));
  // SIGKILL, not SIGTERM: a session is usually ended because a case wedged the worker, and a
  // process spinning inside a synchronous parser is exactly the one a catchable signal cannot reach.
  session.child.kill('SIGKILL');
  await gone;
}

/** A case's verdict, plus whether the worker can take another one. */
type CaseOutcome = { failure: FuzzFailure | null; usable: boolean };

/**
 * Runs one case on a started worker. Startup is already awaited by the caller, so the budget below
 * covers parser time only — the reason a slow import can never be misreported as a parser hang.
 *
 * A worker that hung is wedged in this case and one that died is gone, so neither is `usable`.
 */
async function runCase(
  session: Session,
  target: FuzzTarget,
  input: string,
  caseTimeoutMs: number,
): Promise<CaseOutcome> {
  const failed = (kind: 'hang' | 'crash', detail: string): CaseOutcome => ({
    failure: { target: target.name, input, kind, detail },
    usable: false,
  });
  const crashed = () => failed('crash', `case killed the worker process (${session.death()})`);
  // A worker that died between cases is reported against the case that meets it, rather than
  // through the ERR_IPC_CHANNEL_CLOSED that sending to it would raise: the harness classifies
  // every death of a worker it was using, and an opaque transport error is not a classification.
  if (session.death() !== null) return crashed();
  // Armed before the case is sent, so an answer cannot arrive unobserved.
  const answer = awaitWorker(session.child, caseTimeoutMs);
  session.child.send({ kind: 'case', input });
  const outcome = await answer;
  if (outcome.kind === 'death') return crashed();
  if (outcome.kind === 'silence') {
    return failed('hang', `case did not finish within ${caseTimeoutMs}ms`);
  }
  if (outcome.message.kind !== 'result') {
    throw new Error(`unexpected worker message: ${outcome.message.kind}`);
  }
  return { failure: outcome.message.failure, usable: true };
}

/**
 * A worker-backed runner for one target. A hang leaves the worker wedged in its own loop and a
 * crash leaves no worker at all, so the runner ends the session and starts a fresh one for the
 * next case — otherwise a single such case would silently turn every later case into one too.
 */
export async function createCaseRunner(
  target: FuzzTarget,
  caseTimeoutMs: number,
): Promise<CaseRunner> {
  let session = await startSession(target.name);
  let closed = false;

  return {
    run: async (input) => {
      if (closed) throw new Error('fuzz case runner is closed');
      const { failure, usable } = await runCase(session, target, input, caseTimeoutMs);
      if (!usable) {
        await endSession(session);
        session = await startSession(target.name);
      }
      return failure;
    },
    close: async () => {
      closed = true;
      await endSession(session);
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
