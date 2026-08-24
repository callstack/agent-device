import type { InteractionRetryTap } from './interaction-outcome-policy.ts';
import type { RuntimeAdmissionBindings } from './request-runtime-binding.ts';
import { createBoundTouchExecutor, resolveBoundTouchRuntime } from './touch-runtime.ts';

/**
 * Supplies the interaction-outcome policy with the one device effect it needs: re-firing a
 * recorded coordinate tap through the same bound `tapPoint` the original press used (R48).
 *
 * It lives beside neither party. The policy decides whether a retry is warranted and must stay
 * readable without the binding stack, so it declares the seam and never imports admission; the
 * capture route holds the request's bindings but has no business knowing which touch plan a
 * re-fired tap needs. This is the adapter between them, and every request route that can retry
 * builds it from its own bindings rather than reaching into a module-level one.
 *
 * Answers `undefined` for a route with no bindings to admit with — an internal capture that
 * decorates someone else's request cannot fire a tap, and the policy reports that as a skip.
 */
export function createInteractionRetryTap(
  bindings: RuntimeAdmissionBindings,
): InteractionRetryTap | undefined {
  const { inspectFacts, bindDevice } = bindings;
  if (!inspectFacts || !bindDevice) return undefined;
  // ADR 0019 §9 is one admission per handler, and the outcome policy can call this seam once per
  // retry round. Memoizing per device keeps the facts inspection and the narrowing to the first
  // round: `bindDevice` already caches the underlying binding, so re-resolving would only re-read
  // facts the request has already admitted on.
  const resolutions = new Map<string, ReturnType<typeof resolveBoundTouchRuntime>>();
  return async ({ device, point, context }) => {
    // Admission runs before the policy spends an attempt: an owner whose cell cannot tap answers
    // `false` here and leaves the pending record intact.
    let resolution = resolutions.get(device.id);
    if (!resolution) {
      resolution = resolveBoundTouchRuntime({
        device,
        command: 'press',
        requiresCapture: false,
        inspectFacts,
        bindDevice,
      });
      resolutions.set(device.id, resolution);
    }
    const bound = await resolution;
    if (!bound.ok) return false;
    const executor = createBoundTouchExecutor(bound.runtime, context);
    if (!executor.tapPoint) return false;
    await executor.tapPoint(point);
    return true;
  };
}
