import {
  resolvePlannedRuntimeOperations,
  type PlannedRuntimeOperation,
  type PlannedStep,
} from '@agent-device/command-registry/planned-operations';

/**
 * The part of a multi-step plan (a `batch`) that is still ahead of the request being executed.
 * The batch runner attaches it to each step through the server-private `internal` request channel,
 * which the transport strips from every wire request, so a remote client cannot steer platform
 * readiness policy with it and ADR 0006 stays untouched.
 */
export type ExecutionPlan = Readonly<{ remainingSteps: readonly PlannedStep[] }>;

/**
 * The runtime operations the steps still ahead of an `open` must execute, or `undefined` when the
 * future is unknown. A plan with no remaining step is unknown too: an `open` that ends its batch
 * is a prelude to standalone commands the daemon cannot see yet.
 */
export function resolvePlannedOperations(
  plan: ExecutionPlan | undefined,
): readonly PlannedRuntimeOperation[] | undefined {
  if (plan === undefined || plan.remainingSteps.length === 0) return undefined;
  return resolvePlannedRuntimeOperations(plan.remainingSteps);
}
