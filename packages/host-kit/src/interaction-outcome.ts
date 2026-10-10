import type { ResolvedInteractionTarget } from '@agent-device/contracts/interaction';

const resolvedInteractionTargets = new WeakMap<object, ResolvedInteractionTarget>();

export function attachResolvedInteractionTarget(
  error: unknown,
  target: ResolvedInteractionTarget,
): void {
  if (isObjectLike(error)) resolvedInteractionTargets.set(error, target);
}

export function readResolvedInteractionTarget(
  error: unknown,
): ResolvedInteractionTarget | undefined {
  return isObjectLike(error) ? resolvedInteractionTargets.get(error) : undefined;
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}
