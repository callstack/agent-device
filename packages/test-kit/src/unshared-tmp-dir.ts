/**
 * The run's own directory under the checkout's ignored `.tmp/`, for state a sticky shared directory such as
 * `/tmp` must not hold: the Swift helper cache refuses one anywhere in its chain. The Vitest global setup names
 * it only after checking every level from `/` down, and removes it after the run. A run whose checkout ancestry
 * is not private (a mount another user owns, for example) has none. Every test that does not need it runs
 * without touching it; one that does answers through {@link requireUnsharedTestRunDir}.
 */
export function unsharedTestRunDir(): string | undefined {
  return process.env.AGENT_DEVICE_TEST_UNSHARED_DIR?.trim() || undefined;
}

/** The part of a test context that can skip the test. */
export type SkippableTest = Readonly<{ skip: (note: string) => never }>;

/**
 * The run's checkout-local directory, for a test that needs it. Without one the test is skipped with the
 * ancestry reason, except on CI (`CI` set), where the test fails instead: there a skip would hide exactly what
 * it guards.
 */
export function requireUnsharedTestRunDir(test: SkippableTest): string {
  const runDir = unsharedTestRunDir();
  if (runDir) return runDir;
  const reason =
    process.env.AGENT_DEVICE_TEST_UNSHARED_UNAVAILABLE ?? 'no checkout-local directory was named';
  if (process.env.CI) throw new Error(`This test needs a private checkout ancestry: ${reason}`);
  return test.skip(`checkout ancestry not private; Swift cache tests skipped: ${reason}`);
}
