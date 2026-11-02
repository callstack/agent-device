/**
 * One bounded wait, for the work a lease's lifecycle awaits but does not own: a create that may be
 * retrying, a session connection still handshaking, an ADB `connect` the SDK started without a deadline,
 * or a capture still opening its destination tunnel. Every one of these can answer later than a release
 * or a daemon close may wait, and none of them may keep an instance billed while its caller is unresolved.
 *
 * Expiry is a reported outcome rather than a thrown one, and the work being waited on is never cancelled:
 * it runs to its end, and its owner disposes what it eventually makes.
 */

/**
 * How the wait ended, kept so a caller states which work was still outstanding rather than guessing.
 * A work item that refused is an outcome of its own: every wait this type answers for is reporting,
 * cleanup, or a handshake somebody else can still act on, so a refusal is never this route's failure
 * to re-raise — it maps to this variant and the caller says what it could not use.
 */
export type LimrunBudgetOutcome<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; expired: true }>
  | Readonly<{ ok: false; rejected: true; error: unknown }>;

/**
 * Waits for `work` within `budgetMs`, unref'd so a daemon close is never held open by the timer alone.
 * Both of the work's answers are mapped to outcomes in this step, so a work item that rejects can
 * never reach the process as an unhandled rejection, whether it answers inside the budget or after it.
 */
export async function awaitLimrunWithinBudget<T>(
  work: Promise<T>,
  budgetMs: number,
): Promise<LimrunBudgetOutcome<T>> {
  const settled = Promise.resolve(work).then(
    (value): LimrunBudgetOutcome<T> => ({ ok: true, value }),
    (error: unknown): LimrunBudgetOutcome<T> => ({ ok: false, rejected: true, error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      settled,
      new Promise<LimrunBudgetOutcome<T>>((expired) => {
        timer = setTimeout(() => expired({ ok: false, expired: true }), budgetMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Keeps work that was started without being awaited yet observed for as long as that lasts: the handler
 * attached here is what stops a refusal that arrives before the awaiting step from reaching the process as
 * an unhandled rejection. The same promise comes back, so the route that starts the work is still the one
 * that awaits what it answers with.
 */
export function keepLimrunObserved<T>(work: Promise<T>): Promise<T> {
  void work.catch(() => undefined);
  return work;
}

/**
 * Why an outcome is not confirmed: the work this runtime stopped waiting for. It is reported rather than
 * dropped, because whoever reads it has to say whether the resource may still be running.
 */
export function workOutstandingFailure(work: string, budgetMs: number): string {
  return `${work} had not answered within ${String(budgetMs / 1000)} s`;
}

/** Joins why a delete failed with the local work that outlived its budget, delete first. */
export function joinOutcomeFailures(
  deleteFailure: string | undefined,
  outstanding: string | undefined,
): string | undefined {
  if (deleteFailure === undefined) return outstanding;
  return outstanding === undefined ? deleteFailure : `${deleteFailure}; ${outstanding}`;
}
