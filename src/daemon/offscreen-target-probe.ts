import type { Rect, SnapshotNode } from '@agent-device/kernel/snapshot';
import { isConfirmedOnScreenProbe } from '../snapshot/mobile-snapshot-semantics.ts';
import { deriveDirectIosNodeSelector } from './direct-ios-selector.ts';
import { queryDirectIosSelector } from './selector-runtime.ts';
import type { AppleRunnerRequestOptions } from './apple-runner-options.ts';
import type { SessionState } from './types.ts';

/**
 * #1542 off-screen refusal double-check: the I/O side of
 * `AgentDeviceBackend.confirmOffscreenTargetVisible`. Called ONLY at the
 * moment the off-screen interaction guard (`src/commands/interaction/runtime/
 * resolution.ts`) is about to REFUSE a click/tap/gesture-target resolution on
 * iOS, to re-confirm the target directly — bypassing whatever bulk
 * accessibility tree the guard's verdict came from.
 *
 * Root cause this rescues: a keyboard-dismiss content-offset correction can
 * leave a ScrollView's bulk AX frame squeezed to a stale value (or, in the
 * frozen-tree manifestation, the WHOLE bulk tree pinned at pre-gesture
 * values) while the actual on-screen state is fine. `queryDirectIosSelector`
 * (reused from `selector-runtime.ts` — no second querySelector client) reads
 * the target fresh, straight from XCTest, so it is not subject to either
 * failure mode.
 *
 * Returns the element's LIVE rect (which the caller must use for the
 * eventual tap point — the bulk-tree rect can be stale even when the
 * decision to proceed is correct) only when the read positively confirms
 * on-screen: unambiguously resolved, `hittable`, and its tap point falls
 * inside `rootViewport`. Any other outcome — no usable id/label, not found,
 * ambiguous match, transport error, not hittable, or outside the viewport —
 * returns `null`, and the guard MUST fail closed (refuse) on `null`. This is
 * a rescue path only, never a way to relax a genuine refusal.
 *
 * Session eligibility (local, non-provider iOS; postGestureStabilization NOT
 * skipped — see `isLocalIosRunnerSession`) is the caller's job: this
 * function assumes it is only ever wired up for an eligible session, same as
 * every other optional `AgentDeviceBackend` method.
 */
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
    // Ambiguous matches, ELEMENT_NOT_FOUND, and transport failures all land
    // here — every one of them means "could not confirm on-screen," which
    // must fail the double-check closed, not be classified further.
    return null;
  }
  if (!result.found || !result.node?.rect) return null;
  const probe = { rect: result.node.rect, hittable: result.node.hittable === true };
  return isConfirmedOnScreenProbe(probe, rootViewport) ? probe.rect : null;
}
