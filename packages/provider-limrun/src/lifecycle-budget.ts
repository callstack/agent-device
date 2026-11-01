/**
 * One bounded wait, for the work a lease's lifecycle awaits but does not own: a create that may be
 * retrying, a session connection still handshaking, an ADB `connect` the SDK started without a deadline,
 * or a capture still opening its destination tunnel. Every one of these can answer later than a release
 * or a daemon close may wait, and none of them may keep an instance billed while its caller is unresolved.
 *
 * Expiry is a reported outcome rather than a thrown one, and the work being waited on is never cancelled:
 * it runs to its end, and its owner disposes what it eventually makes.
 */

/** How the wait ended, kept so a caller states which work was still outstanding rather than guessing. */
export type LimrunBudgetOutcome<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; expired: true }>;

/**
 * Waits for `work` within `budgetMs`, unref'd so a daemon close is never held open by the timer alone.
 * A work item that was too slow to be awaited is kept observed, so the outcome it reports later cannot
 * surface as an unhandled rejection.
 */
export async function awaitLimrunWithinBudget<T>(
  work: Promise<T>,
  budgetMs: number,
): Promise<LimrunBudgetOutcome<T>> {
  void Promise.resolve(work).catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then((value): LimrunBudgetOutcome<T> => ({ ok: true, value })),
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
