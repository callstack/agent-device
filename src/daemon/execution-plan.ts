import type { OpenApplicationPlan } from '@agent-device/contracts/application-lifecycle-runtime';
import { resolvePlannedRuntimeOperations } from '../core/command-descriptor/planned-operations.ts';

/**
 * The part of a multi-step plan (a `batch`) that is still ahead of the request being executed.
 * The batch runner attaches it to each step through the server-private `internal` request channel,
 * which the transport strips from every wire request, so a remote client cannot steer platform
 * readiness policy with it and ADR 0006 stays untouched.
 */
export type ExecutionPlan = Readonly<{ remainingCommands: readonly string[] }>;

/**
 * The declared runtime operations of the steps still ahead of an `open`, or `undefined` when the
 * future is unknown. A plan with no remaining step is unknown too: an `open` that ends its batch
 * is a prelude to standalone commands the daemon cannot see yet.
 */
export function resolveOpenApplicationPlan(
  plan: ExecutionPlan | undefined,
): OpenApplicationPlan | undefined {
  if (plan === undefined || plan.remainingCommands.length === 0) return undefined;
  const operations = resolvePlannedRuntimeOperations(plan.remainingCommands);
  return operations === undefined ? undefined : { operations };
}
