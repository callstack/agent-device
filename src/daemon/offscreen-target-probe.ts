import type { Rect, SnapshotNode } from '@agent-device/kernel/snapshot';
import { isConfirmedOnScreenProbe } from '@agent-device/capture-kit/mobile-snapshot-semantics';
import type { QuerySelectorRuntimeOperations } from '@agent-device/contracts/selector-observation-runtime';
import type { SnapshotRuntimeExecution } from '@agent-device/contracts/snapshot-runtime';
import { deriveDirectIosNodeSelector, queryDirectIosSelector } from './direct-ios-selector.ts';
import type { SessionState } from './session-state.ts';

export async function confirmIosOffscreenTargetVisible(params: {
  session: SessionState;
  node: Pick<SnapshotNode, 'identifier' | 'label'>;
  rootViewport: Rect | null;
  querySelector: QuerySelectorRuntimeOperations['querySelector'];
  execution: SnapshotRuntimeExecution;
  signal?: AbortSignal;
}): Promise<Rect | null> {
  const { session, node, rootViewport, querySelector, execution } = params;
  const selector = deriveDirectIosNodeSelector(node);
  if (!selector) return null;
  let result: Awaited<ReturnType<typeof queryDirectIosSelector>>;
  try {
    result = await queryDirectIosSelector(session, selector, querySelector, {
      execution,
      ...(params.signal === undefined ? {} : { signal: params.signal }),
    });
  } catch {
    return null;
  }
  if (!result.found || !result.node?.rect) return null;
  const probe = { rect: result.node.rect, hittable: result.node.hittable === true };
  return isConfirmedOnScreenProbe(probe, rootViewport) ? probe.rect : null;
}
