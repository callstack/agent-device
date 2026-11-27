/**
 * A process-local startup fence keyed by durable state scope. Recovery code registers before it
 * awaits any lazy implementation load; a concurrent mutation therefore cannot overtake recovery
 * merely because its platform mechanics have not been imported yet.
 */
const startupRecoveryFences = new Map<string, Promise<void>>();

/** Runs one recovery per durable scope and makes a concurrent mutation wait for it. */
export async function runStartupRecoveryFence(
  scope: string,
  recover: () => Promise<void>,
): Promise<void> {
  const existing = startupRecoveryFences.get(scope);
  if (existing) {
    await existing;
    return;
  }
  const { promise: fence, resolve: release } = Promise.withResolvers<void>();
  startupRecoveryFences.set(scope, fence);
  try {
    await recover();
  } finally {
    if (startupRecoveryFences.get(scope) === fence) startupRecoveryFences.delete(scope);
    release();
  }
}

/** A pre-mutation wait: it observes a fence that was registered before lazy recovery work starts. */
export async function waitForStartupRecoveryFence(scope: string): Promise<void> {
  await startupRecoveryFences.get(scope);
}

/** @internal Test isolation hook. */
export function resetStartupRecoveryFencesForTests(): void {
  startupRecoveryFences.clear();
}
