import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { areRectsApproximatelyEqual } from '@agent-device/kernel/rect-center';
import type { TargetHittability } from '@agent-device/contracts/backend';
import type {
  HittabilityProbeReading,
  QuerySelectorRuntimeOperations,
} from '@agent-device/contracts/selector-observation-runtime';
import type { SnapshotRuntimeExecution } from '@agent-device/contracts/snapshot-runtime';
import { deriveDirectIosNodeSelector } from '../core/direct-ios-selector.ts';
import type { SessionState } from '../core/session-state.ts';

/**
 * Maps one lean probe reading to a verdict about the resolved target. Only a single match whose
 * live frame is the target's own frame may speak for it: another count, a missing reading, or a
 * frame elsewhere means the selector described a different element, and the verdict is `unknown`.
 */
export function classifyHittabilityReading(
  reading: HittabilityProbeReading | undefined,
  targetRect: SnapshotNode['rect'],
): TargetHittability {
  if (reading?.matchCount !== 1) return 'unknown';
  if (reading.hittable === undefined || !areRectsApproximatelyEqual(reading.rect, targetRect)) {
    return 'unknown';
  }
  return reading.hittable ? 'hittable' : 'notHittable';
}

/**
 * The pre-dispatch hittability read of one target: one lean `querySelector` probe on the caller's
 * request-bound operation, scoped to the session's application like the off-screen rescue read.
 * A node with no selector, and a failed read of any kind, answer `unknown`.
 */
export async function probeIosTargetHittability(params: {
  session: SessionState;
  node: Pick<SnapshotNode, 'identifier' | 'label' | 'rect'>;
  querySelector: QuerySelectorRuntimeOperations['querySelector'];
  execution: SnapshotRuntimeExecution;
  /** The admission read's own signal: cancellation and the request deadline end the native read. */
  signal?: AbortSignal;
}): Promise<TargetHittability> {
  const { session, node, querySelector, execution, signal } = params;
  const selector = deriveDirectIosNodeSelector(node);
  if (!selector) return 'unknown';
  try {
    const { hittability } = await querySelector({
      selector,
      probe: 'hittability',
      ...(signal ? { signal } : {}),
      ...(session.appBundleId === undefined
        ? {}
        : { options: { appBundleId: session.appBundleId } }),
      execution,
    });
    return classifyHittabilityReading(hittability, node.rect);
  } catch {
    return 'unknown';
  }
}
