import { isIosFamily } from '@agent-device/kernel/device';
import type { Rect, SnapshotNode } from '@agent-device/kernel/snapshot';
import { isActiveProviderDevice } from '../provider-device-runtime.ts';
import type { SessionState } from './types.ts';
import { tryParseSelectorChain } from '../selectors/index.ts';
import { asAppError } from '@agent-device/kernel/errors';
import type { ElementSelectorTapOptions } from '@agent-device/contracts/interaction';
import { runAppleRunnerCommand } from '../platforms/apple/core/runner/runner-client.ts';
import type { AppleRunnerRequestOptions } from './apple-runner-options.ts';

export type DirectIosSelectorTarget = ElementSelectorTapOptions & { raw: string };

export function readSimpleIosSelectorTarget(params: {
  session: SessionState | undefined;
  selectorExpression: string;
}): DirectIosSelectorTarget | null {
  const { session, selectorExpression } = params;
  if (!session) return null;
  if (!isIosFamily(session.device)) return null;
  // This fast path talks directly to the local XCTest runner. Provider-owned
  // iOS devices must resolve through their interactor-backed snapshot runtime
  // instead, which keeps selectors and interaction guarantees on one backend.
  if (isActiveProviderDevice(session.device)) return null;
  if (session.postGestureStabilization) return null;
  const chain = tryParseSelectorChain(selectorExpression);
  if (!chain) return null;
  if (chain.selectors.length !== 1) return null;
  const selector = chain.selectors[0];
  if (!selector || selector.terms.length !== 1) return null;
  const term = selector.terms[0];
  if (!term || typeof term.value !== 'string') return null;
  if (!isRunnerNativeSelectorKey(term.key)) return null;
  return { key: term.key, value: term.value, raw: selector.raw };
}

function isRunnerNativeSelectorKey(key: string): key is DirectIosSelectorTarget['key'] {
  return key === 'id' || key === 'label' || key === 'text' || key === 'value';
}

/**
 * #1542: is this session eligible for the off-screen refusal double-check's
 * direct XCUIElement read? Same "local XCTest runner, not a provider-owned
 * device" boundary `readSimpleIosSelectorTarget` uses — provider-owned iOS
 * devices resolve through their own interactor-backed runtime instead.
 * Deliberately does NOT gate on `session.postGestureStabilization` like the
 * tap fast path does: the double-check exists specifically to cover the
 * window where the bulk AX tree is stale (pending or just-cleared
 * stabilization), so excluding that window here would defeat the purpose.
 */
export function isIosDirectElementReadEligible(
  session: SessionState | undefined,
): session is SessionState {
  if (!session) return false;
  if (!isIosFamily(session.device)) return false;
  if (isActiveProviderDevice(session.device)) return false;
  return true;
}

/**
 * The selector a bulk-tree node's OWN attributes give us for a direct runner
 * re-read: prefer the stable `id` (accessibility identifier), fall back to
 * `label`. Neither is guaranteed unique on the runner side — an ambiguous
 * match is handled by the caller (`readDirectIosElementRect` returns `null`,
 * which fails the double-check closed, exactly like "not found").
 */
export function deriveDirectIosNodeSelector(
  node: Pick<SnapshotNode, 'identifier' | 'label'>,
): { key: 'id' | 'label'; value: string } | null {
  const identifier = node.identifier?.trim();
  if (identifier) return { key: 'id', value: identifier };
  const label = node.label?.trim();
  if (label) return { key: 'label', value: label };
  return null;
}

export type DirectIosElementProbe = {
  rect: Rect;
  /**
   * XCTest's OWN live `isHittable` for this element — computed fresh against
   * the current window/clip state, not read off a cached bulk AX snapshot.
   * This is why the double-check needs only ONE query for the target and
   * none for its scroll ancestor: unlike the bulk tree's `hittable` (which
   * inherits the SAME AX-degradation risk as the corrupted ancestor rect —
   * see the `hittable` unreliability note on `describeNonHittableTarget`),
   * a single-element live query re-derives hit-testing from scratch, so it
   * already accounts for ancestor clipping without this code re-deriving an
   * ancestor's rect itself (which live validation showed is often ambiguous
   * to re-select by label — e.g. a ScrollView and a sibling wrapper sharing
   * the same accessibility label).
   */
  hittable: boolean;
};

/**
 * #1542: a single, tree-independent probe for one element, straight from the
 * local XCTest runner's `querySelector` command (the same primitive
 * `readSimpleIosSelectorTarget`'s callers already use for reads/taps). Used
 * ONLY by the off-screen refusal double-check, so any failure to
 * unambiguously resolve the element — no usable id/label, not found,
 * ambiguous match, or a transport error — returns `null` rather than
 * throwing: the caller's contract is to fail closed on `null`.
 */
export async function readDirectIosElementProbe(
  session: SessionState,
  node: Pick<SnapshotNode, 'identifier' | 'label'>,
  requestOptions: AppleRunnerRequestOptions,
): Promise<DirectIosElementProbe | null> {
  const selector = deriveDirectIosNodeSelector(node);
  if (!selector) return null;
  try {
    const data = await runAppleRunnerCommand(
      session.device,
      {
        command: 'querySelector',
        selectorKey: selector.key,
        selectorValue: selector.value,
        appBundleId: session.appBundleId,
      },
      requestOptions,
    );
    if (data.found !== true) return null;
    const nodes = data.nodes;
    if (!Array.isArray(nodes) || nodes.length !== 1) return null;
    const found = nodes[0] as SnapshotNode | undefined;
    if (!found?.rect) return null;
    return { rect: found.rect, hittable: found.hittable === true };
  } catch {
    // Ambiguous matches, ELEMENT_NOT_FOUND, and transport failures all land
    // here — every one of them means "could not confirm on-screen," which
    // must fail the double-check closed, not be classified further.
    return null;
  }
}

export function isDirectIosSelectorFallbackError(
  error: unknown,
  options: {
    /**
     * Read/query callers (wait/get/is): a runner ELEMENT_NOT_FOUND re-resolves
     * against the daemon tree, but AMBIGUOUS_MATCH still surfaces as-is.
     */
    allowElementNotFound?: boolean;
    /**
     * ADR 0011 delegation-on-error for interaction dispatches: the runner's
     * semantic failure shapes (ELEMENT_NOT_FOUND, AMBIGUOUS_MATCH) fall back
     * to the tree-based runtime path, which supplies runtime disambiguation,
     * non-hittable promotion/annotation, occlusion refusal, and rich selector
     * diagnostics/hints. Must stay OFF for Maestro replay dispatches
     * (allowNonHittableCoordinateFallback): replay matching is intentionally
     * runner-native, so those error shapes must surface unchanged.
     */
    delegateSemanticFailures?: boolean;
  } = {},
): boolean {
  const appError = asAppError(error);
  if (appError.code === 'ELEMENT_NOT_FOUND') {
    return options.delegateSemanticFailures === true || options.allowElementNotFound === true;
  }
  if (appError.code === 'AMBIGUOUS_MATCH') return options.delegateSemanticFailures === true;
  // Regular interactions delegate off-screen matches to the shared tree, which
  // can prefer an on-screen candidate or raise offscreen_selector. Maestro
  // replay keeps the typed runner outcome so its compatibility resolver can
  // apply Maestro-specific ranking and tab-strip inference instead.
  if (appError.code === 'ELEMENT_OFFSCREEN') {
    return options.delegateSemanticFailures !== false;
  }
  if (appError.code !== 'COMMAND_FAILED') return false;
  // Transport-failure classification stays message-based deliberately: the
  // sniffed shapes originate at 4+ scattered throw sites (runner-transport
  // deadline errors, runner-contract connect errors, runner-session's invalid
  // response) plus raw undici "fetch failed" TypeErrors that are only wrapped
  // into AppError at this boundary — and isRetryableRunnerError performs the
  // same message sniffing for retry policy. A typed transport marker needs a
  // wrapping layer around all of them in one change; tracked as Tier-3 error
  // cleanup, not worth entangling with this fallback decision.
  const message = appError.message.toLowerCase();
  return (
    message.includes('fetch failed') ||
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('runner did not accept connection') ||
    message.includes('invalid runner response')
  );
}
