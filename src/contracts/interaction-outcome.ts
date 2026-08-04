import type { ResolvedInteractionTarget } from '@agent-device/contracts/interaction';

// The runtime can resolve an interaction before the backend reports a failure.
// Keep that resolution out of serialized error details while making it
// available to the daemon's failure-corroboration boundary.
const resolvedInteractionTargets = new WeakMap<object, ResolvedInteractionTarget>();

/** Preserve pre-dispatch target identity across a backend rejection. */
export function attachResolvedInteractionTarget(
  error: unknown,
  target: ResolvedInteractionTarget,
): void {
  if (isObjectLike(error)) resolvedInteractionTargets.set(error, target);
}

/** Read the target captured before a backend interaction rejection. */
export function readResolvedInteractionTarget(
  error: unknown,
): ResolvedInteractionTarget | undefined {
  return isObjectLike(error) ? resolvedInteractionTargets.get(error) : undefined;
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}
