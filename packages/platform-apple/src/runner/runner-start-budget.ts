import {
  AppError,
  createRequestCanceledError,
  isRequestCanceledError,
} from '@agent-device/kernel/errors';
import { emitDiagnostic } from './host.ts';
import { resolveRunnerStartupSignal } from './runner-contract.ts';
import { createRunnerPhaseBudget, type RunnerPhaseBudget } from './runner-xctestrun.ts';
import { normalizeRunnerStartupTimeoutMs, type RunnerSession } from './runner-session-types.ts';
import type { AppleRunnerLifecycleOptions } from './runner-provider.ts';

type RunnerSessionOptions = AppleRunnerLifecycleOptions;

/**
 * What a runner start may spend when its caller sets no `startupTimeoutMs`: the reuse probe,
 * adoption, boot, device readiness, the xctestrun build and the launch, on one clock the start owns
 * (#2894). Sized for a cold build: `prepare` defaults to 240 s for the same work plus its health
 * check (`PREPARE_STARTUP_BUDGET_MS`), the iOS CI lane gives a cold `prepare` on a shared macOS
 * runner 420 s (`AGENT_DEVICE_IOS_PREPARE_TIMEOUT_MS`), and a daemon queued on another process's
 * build of the same artifact already gives up after 10 minutes
 * (`RUNNER_XCTESTRUN_CACHE_LOCK_TIMEOUT_MS`). The two ceilings agree, so a start never waits on a
 * peer's build longer than it would spend on its own.
 */
export const DEFAULT_RUNNER_START_BUDGET_MS = 10 * 60_000;

/**
 * The budget one runner start spends, with the clock that enforces it. The abort fires when the
 * deadline is spent, so every step that takes the signal (the xctestrun build and the launch kill
 * their process tree through exec, the probes stop retrying) ends on the same clock the deadline
 * reads. `close` retires the timer once the start has settled: a registered session is bounded by
 * its {@link RunnerSession.launchDeadline} from then on, never by this abort.
 */
export type RunnerStartBudget = Readonly<{
  phase: RunnerPhaseBudget;
  timeoutMs: number;
  explicit: boolean;
  exhausted: AbortSignal;
  close: () => void;
}>;

/**
 * Opens the start's budget from `startupTimeoutMs`, or {@link DEFAULT_RUNNER_START_BUDGET_MS}
 * when the caller sets none. The startup signal (a cancelled request, never a caller's deadline)
 * and the budget's own expiry abort the same signal.
 */
export function openRunnerStartBudget(options: RunnerSessionOptions): RunnerStartBudget {
  const explicitTimeoutMs = normalizeRunnerStartupTimeoutMs(options.startupTimeoutMs);
  const timeoutMs = explicitTimeoutMs ?? DEFAULT_RUNNER_START_BUDGET_MS;
  const exhausted = new AbortController();
  const timer = setTimeout(() => {
    exhausted.abort(runnerStartBudgetExhaustedError(timeoutMs, explicitTimeoutMs !== undefined));
  }, timeoutMs);
  timer.unref?.();
  const startupSignal = resolveRunnerStartupSignal(options);
  const signal = startupSignal
    ? AbortSignal.any([startupSignal, exhausted.signal])
    : exhausted.signal;
  return {
    phase: createRunnerPhaseBudget(timeoutMs, signal),
    timeoutMs,
    explicit: explicitTimeoutMs !== undefined,
    exhausted: exhausted.signal,
    close: () => clearTimeout(timer),
  };
}

/** Says the start's own budget ran out, whichever step it was in; the next request starts over. */
function runnerStartBudgetExhaustedError(timeoutMs: number, explicit: boolean): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `Apple runner start exceeded its ${explicit ? 'startup timeout' : 'default start budget'} of ${timeoutMs}ms`,
    {
      reason: 'runner_start_budget_exhausted',
      timeoutMs,
      retriable: true,
      hint: explicit
        ? 'Raise the startup timeout, or run `prepare ios-runner` first so the runner is built before it is needed.'
        : 'Run `prepare ios-runner --timeout <ms>` so the cold build has a budget of your choosing; the session runner.log names the step that stalled.',
    },
  );
}

/**
 * The start runs detached under the session lock; the caller only waits for it as long as its own
 * signal allows. A caller whose deadline lands during a cold xctestrun build leaves on time, the
 * build keeps going under the lock, and the next request for the device queues behind it and joins
 * the session it registers (#2894). Whatever the abort reason, the caller sees the same cancelled
 * request it would have seen from any later step; a cancelled request's abort also reaches the
 * start through its own startup signal, so nothing here decides whether the start survives. A
 * start that fails after its caller left has nobody to report to, so its failure is logged here.
 */
export async function raceRunnerStartAgainstCaller(
  start: Promise<RunnerSession>,
  signal: AbortSignal | undefined,
): Promise<RunnerSession> {
  if (!signal) return await start;
  return await new Promise<RunnerSession>((resolve, reject) => {
    const abort = () => {
      reject(createRequestCanceledError(undefined, signal.reason));
      start.catch(emitDetachedRunnerStartFailed);
    };
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener('abort', abort, { once: true });
    }
    start.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** A cancelled request killed its start on purpose; any other failure of a start nobody awaits is news. */
function emitDetachedRunnerStartFailed(error: unknown): void {
  if (isRequestCanceledError(error)) return;
  const appErr = error instanceof AppError ? error : undefined;
  emitDiagnostic({
    level: 'warn',
    phase: 'ios_runner_detached_start_failed',
    data: {
      code: appErr?.code,
      reason: appErr?.details?.reason,
      error: error instanceof Error ? error.message : String(error),
    },
  });
}
