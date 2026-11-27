import type { Rect, SnapshotNode } from '@agent-device/kernel/snapshot';
import { isConfirmedOnScreenProbe } from '@agent-device/capture-kit/mobile-snapshot-semantics';
import type { QuerySelectorRuntimeOperations } from '@agent-device/contracts/selector-observation-runtime';
import type { SnapshotRuntimeExecution } from '@agent-device/contracts/snapshot-runtime';
import { deriveDirectIosNodeSelector } from '../core/direct-ios-selector.ts';
import type { SessionState } from '../core/session-state.ts';

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
  /**
   * When set, probes this exact requested `id`/`label` selector with the lean hittability probe
   * (no hittable preference among duplicates) and requires `matchCount === 1` before rescuing.
   */
  exactSelector?: Readonly<{ key: 'id' | 'label'; value: string }>;
}): Promise<Rect | null> {
  const { session, node, rootViewport, querySelector, execution, exactSelector } = params;
  const selector = exactSelector ?? deriveDirectIosNodeSelector(node);
  if (!selector) return null;
  let result: Awaited<ReturnType<typeof querySelector>>;
  try {
    result = await querySelector({
      selector,
      ...(exactSelector ? { probe: 'hittability' as const } : {}),
      ...(session.appBundleId === undefined
        ? {}
        : { options: { appBundleId: session.appBundleId } }),
      execution,
    });
  } catch {
    return null;
  }
  if (exactSelector) {
    const reading = result.hittability;
    if (reading?.matchCount !== 1 || reading.hittable !== true || !reading.rect) return null;
    return isConfirmedOnScreenProbe({ rect: reading.rect, hittable: true }, rootViewport)
      ? reading.rect
      : null;
  }
  if (!result.found || !result.node?.rect) return null;
  const probe = { rect: result.node.rect, hittable: result.node.hittable === true };
  return isConfirmedOnScreenProbe(probe, rootViewport) ? probe.rect : null;
}
