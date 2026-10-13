import type { Rect, SnapshotNode } from '@agent-device/kernel/snapshot';
import { isConfirmedOnScreenProbe } from '@agent-device/capture-kit/mobile-snapshot-semantics';
import type { QuerySelectorRuntimeOperations } from '@agent-device/contracts/selector-observation-runtime';
import type { SnapshotRuntimeExecution } from '@agent-device/contracts/snapshot-runtime';
import { deriveDirectIosNodeSelector } from './direct-ios-selector.ts';
import type { SessionState } from './session-state.ts';

/**
 * The #1542 rescue read: one live `querySelector` on the caller's request-bound operation,
 * projected against the root viewport. The session's app scope rides along — the runner read is
 * scoped to an application exactly as the retired daemon-side probe scoped its own call. The
 * read fails closed (null) on anything short of a positive, hittable, in-viewport answer, and
 * an owner error stays swallowed here: a failed call must look like a genuine refusal, never a
 * crash inside a guard that was about to refuse anyway.
 */
export async function confirmIosOffscreenTargetVisible(params: {
  session: SessionState;
  node: Pick<SnapshotNode, 'identifier' | 'label'>;
  rootViewport: Rect | null;
  querySelector: QuerySelectorRuntimeOperations['querySelector'];
  execution: SnapshotRuntimeExecution;
}): Promise<Rect | null> {
  const { session, node, rootViewport, querySelector, execution } = params;
  const selector = deriveDirectIosNodeSelector(node);
  if (!selector) return null;
  let found: boolean;
  let nodeReading: Awaited<ReturnType<typeof querySelector>>['node'];
  try {
    ({ found, node: nodeReading } = await querySelector({
      selector,
      ...(session.appBundleId === undefined
        ? {}
        : { options: { appBundleId: session.appBundleId } }),
      execution,
    }));
  } catch {
    return null;
  }
  if (!found || !nodeReading?.rect) return null;
  const probe = { rect: nodeReading.rect, hittable: nodeReading.hittable === true };
  return isConfirmedOnScreenProbe(probe, rootViewport) ? probe.rect : null;
}
