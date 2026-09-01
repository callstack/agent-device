import type { Rect, SnapshotNode } from '@agent-device/kernel/snapshot';
import { isConfirmedOnScreenProbe } from '@agent-device/capture-kit/mobile-snapshot-semantics';
import { deriveDirectIosNodeSelector, queryDirectIosSelector } from './direct-ios-selector.ts';
import type { AppleRunnerRequestOptions } from './apple-runner-options.ts';
import type { SessionState } from './types.ts';

export async function confirmIosOffscreenTargetVisible(params: {
  session: SessionState;
  node: Pick<SnapshotNode, 'identifier' | 'label'>;
  rootViewport: Rect | null;
  requestOptions: AppleRunnerRequestOptions;
}): Promise<Rect | null> {
  const { session, node, rootViewport, requestOptions } = params;
  const selector = deriveDirectIosNodeSelector(node);
  if (!selector) return null;
  let result: Awaited<ReturnType<typeof queryDirectIosSelector>>;
  try {
    result = await queryDirectIosSelector(session, selector, requestOptions);
  } catch {
    return null;
  }
  if (!result.found || !result.node?.rect) return null;
  const probe = { rect: result.node.rect, hittable: result.node.hittable === true };
  return isConfirmedOnScreenProbe(probe, rootViewport) ? probe.rect : null;
}
